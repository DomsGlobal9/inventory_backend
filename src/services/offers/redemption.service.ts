/**
 * Spending an offer's allowance, and giving it back.
 *
 * `SalesOrderDiscount` records what came OFF an order. This records that the offer's allowance
 * was SPENT. They are the same event seen from two ends, and they have to be kept apart because
 * they do not always move together: an order cancelled before it ships gives the allowance back
 * while its discount rows stay exactly where they are, as the record of what was once agreed.
 *
 * Everything here takes a transaction client and does its work INSIDE the caller's transaction.
 * That is the whole reason this file exists rather than a few lines in the order service:
 *
 *     "first 50 customers only" -- two checkouts at once, both read usageCount = 49, both
 *     decide there is room, both write. Fifty-one.
 *
 * Checking a limit and spending it have to be one indivisible step, and at PostgreSQL's default
 * isolation a read followed by a write is not one. So the check is written INTO the update --
 * `WHERE usage_count < usage_limit` -- and the database decides, once, for everybody.
 */

import { Prisma } from '@prisma/client';
import { conflict } from '../../utils/httpError';
import { fromMinor } from '../pricing/money';

export interface RedemptionRequest {
  offerId: string;
  /** The rule as it stood. Null is resolved to the offer's current version. */
  offerVersionId?: string | null;
  amountMinor: number;
  /** The code that unlocked it. For a single-use offer this code is spent here, once. */
  code?: string | null;
}

export interface RedemptionContext {
  clientId: string;
  salesOrderId: string;
  customerId?: string | null;
}

export class OfferRedemptionService {
  /**
   * Count one order's use of every offer that touched it.
   *
   * Throws when an offer has run out between being quoted and being ordered. That is the
   * correct answer even though it is an unhappy one: the alternative is honouring a "first 50"
   * offer for the fifty-first customer, and a shop that advertised fifty means fifty.
   *
   * The whole order fails with it, deliberately. A half-written order whose discount was
   * refused but whose stock was reserved is worse than no order.
   */
  async record(tx: any, ctx: RedemptionContext, requests: RedemptionRequest[]) {
    if (requests.length === 0) return [];

    /*
     * One row per offer, however many lines it touched.
     *
     * The engine reports a line-level offer once per line it applied to. Counting each of those
     * as a use would spend a "one per customer" allowance three times on a basket of three
     * sarees, and `@@unique([offerId, salesOrderId])` would refuse the second write anyway.
     */
    const merged = new Map<string, RedemptionRequest>();
    for (const r of requests) {
      if (!r.offerId || r.amountMinor <= 0) continue;
      const at = merged.get(r.offerId);
      if (at) at.amountMinor += r.amountMinor;
      else merged.set(r.offerId, { ...r, code: r.code ?? null });
    }
    if (merged.size === 0) return [];

    const offers = await tx.offer.findMany({
      where: { id: { in: [...merged.keys()], }, clientId: ctx.clientId },
      select: {
        id: true, name: true, currentVersionId: true,
        usageLimit: true, usageLimitPerCustomer: true, uniqueCodes: true
      }
    });
    const byId = new Map(offers.map((o: any) => [o.id, o]));

    const written: any[] = [];

    // Claimed in one fixed order. Each claim locks its offer's row until the order commits, so two
    // tills taking [saree offer, blouse offer] and [blouse offer, saree offer] at the same moment
    // would each wait on the other's lock, and the database kills one of them.
    const inOrder = [...merged.values()].sort((a, b) => (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0));

    for (const request of inOrder) {
      const offer: any = byId.get(request.offerId);
      if (!offer) {
        // Archived and hard-deleted between the quote and the order. Vanishingly rare, and
        // still not something to write a redemption against a missing rule for.
        throw conflict('One of the offers on this order no longer exists. Price the basket again.');
      }

      /*
       * Claim the allowance.
       *
       * Raw, because Prisma's updateMany cannot compare two COLUMNS -- it can say
       * `usage_count < 50` but not `usage_count < usage_limit`, and the limit is per offer.
       * Writing the comparison in SQL keeps check and spend in one statement, which is the
       * entire point.
       */
      const claimed: number = await tx.$executeRaw(Prisma.sql`
        UPDATE "offers"
           SET "usage_count" = "usage_count" + 1,
               "updated_at"  = NOW()
         WHERE "id" = ${request.offerId}
           AND "client_id" = ${ctx.clientId}
           AND ("usage_limit" IS NULL OR "usage_count" < "usage_limit")
      `);

      if (claimed === 0) {
        throw conflict(
          `"${offer.name}" has been used as many times as it was meant to be. ` +
          `Price this basket again without it.`
        );
      }

      /*
       * The per-customer limit.
       *
       * Counted rather than claimed, because there is nowhere on the offer to keep a count per
       * person -- it is a property of the pair. Two simultaneous checkouts by the SAME customer
       * could still both pass this, which is a far smaller hole than the global one above: it
       * needs one person checking out twice in the same instant, and the worst outcome is one
       * extra use of one offer. Closing it properly needs a per-customer row with a unique key,
       * which is the right thing to add the first time a shop asks for it.
       */
      if (offer.usageLimitPerCustomer != null) {
        if (!ctx.customerId) {
          throw conflict(
            `"${offer.name}" is limited per customer, so it cannot be used without one.`
          );
        }
        const already = await tx.offerRedemption.count({
          where: {
            clientId: ctx.clientId,
            offerId: offer.id,
            customerId: ctx.customerId,
            status: 'COUNTED'
          }
        });
        if (already >= offer.usageLimitPerCustomer) {
          throw conflict(
            `This customer has already used "${offer.name}" as often as they may. ` +
            `Price this basket again without it.`
          );
        }
      }

      /*
       * The single-use code, spent in the same breath as the allowance.
       *
       * Claimed with the same compare-and-set: two tills taking the same printed card at the same
       * moment both quoted it as good, and exactly one of them may have it.
       */
      if (offer.uniqueCodes) {
        const code = String(request.code ?? '').trim().toUpperCase();
        if (!code) {
          throw conflict(`"${offer.name}" needs one of its codes. Price the basket again with the code.`);
        }
        const spent = await tx.offerCode.updateMany({
          where: { clientId: ctx.clientId, offerId: offer.id, code, usedAt: null },
          data: { usedAt: new Date(), salesOrderId: ctx.salesOrderId }
        });
        if (spent.count === 0) {
          throw conflict(`The code ${code} has already been used. Price the basket again without it.`);
        }
      }

      const row = await tx.offerRedemption.create({
        data: {
          clientId: ctx.clientId,
          offerId: offer.id,
          // An order records a VERSION, not the offer, so editing "20% off" down to "10% off"
          // in November cannot rewrite what October's customers were charged.
          offerVersionId: request.offerVersionId ?? offer.currentVersionId,
          salesOrderId: ctx.salesOrderId,
          customerId: ctx.customerId ?? null,
          amount: fromMinor(request.amountMinor),
          status: 'COUNTED'
        }
      });

      written.push(row);
    }

    return written;
  }

  /**
   * Give the allowance back.
   *
   * Called when an order is cancelled BEFORE anything shipped, and never for a return. That
   * asymmetry is deliberate and matches Shopify: a cancelled order was never a sale, but a
   * returned one was -- and giving the allowance back on a return means a "one per customer"
   * offer can be used, refunded, and used again, for ever.
   *
   * The rows are updated rather than deleted. What an order once redeemed is history, and the
   * offer's report has to be able to say "used 40 times, 3 of them released".
   */
  async release(tx: any, clientId: string, salesOrderId: string, reason = 'Order cancelled') {
    const counted = await tx.offerRedemption.findMany({
      where: { clientId, salesOrderId, status: 'COUNTED' },
      select: { id: true, offerId: true }
    });
    if (counted.length === 0) return 0;

    // A single-use code spent on an order that never happened is good again -- the customer still
    // holds the card, and the shop still owes them the offer printed on it.
    await tx.offerCode.updateMany({
      where: { clientId, salesOrderId },
      data: { usedAt: null, salesOrderId: null }
    });

    let released = 0;
    for (const row of counted) {
      /*
       * Released one at a time, and only if still counted. Two cancels of the same order at the
       * same moment both READ these rows as counted; without the status in the WHERE both would
       * then give the use back, and a "first 50" offer would serve 51. The second one's update now
       * waits for the first to commit, finds the row already released, and gives nothing back.
       */
      const flipped = await tx.offerRedemption.updateMany({
        where: { id: row.id, status: 'COUNTED' },
        data: { status: 'RELEASED' }
      });
      if (flipped.count === 0) continue;
      released++;
      // GREATEST, so a counter that has already been corrected by hand cannot be driven
      // negative by a release -- a negative allowance would then let the offer run for ever.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "offers"
           SET "usage_count" = GREATEST("usage_count" - 1, 0),
               "updated_at"  = NOW()
         WHERE "id" = ${row.offerId}
           AND "client_id" = ${clientId}
      `);
    }

    if (released > 0) {
      console.log(`[offers] released ${released} redemption(s) on order ${salesOrderId} -- ${reason}`);
    }
    return released;
  }
}

export const offerRedemptionService = new OfferRedemptionService();
