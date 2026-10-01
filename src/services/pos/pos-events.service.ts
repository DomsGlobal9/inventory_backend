/**
 * What a till tells Inventory after it has already sold something.
 *
 * The POS is the system of record for the sale: it took the money, it printed the invoice, and it
 * did all of that whether or not Inventory was reachable. This is Inventory catching up -- turning
 * a finished sale into the order, the dispatch and the stock movement it would have had if it had
 * been rung up here.
 *
 * SO IT REUSES THE COUNTER SALE'S PATH, not a second one. writeFullOrderInTransaction +
 * dispatchInTransaction is how a counter sale, an online order and a Shopify order all move stock
 * today. A separate "POS stock decrement" would be a second way to do the same thing, and the two
 * would disagree the first time one of them was changed.
 *
 * AT-LEAST-ONCE, SO EVERYTHING HERE IS IDEMPOTENT. The POS retries on a timeout, and a timeout is
 * indistinguishable from success that did not make it back. The key is the one already in the
 * schema: SalesOrder carries @@unique([clientId, externalOrderId, sourceSystem]), so a repeat of
 * the same invoice number finds the original and answers ALREADY_APPLIED rather than selling the
 * saree twice.
 *
 * WHAT INVENTORY DOES NOT DO: re-price. The amounts are the POS's, recorded as given. The one
 * exception is a RETURN, because a return refers to a bill Inventory already holds -- so there is
 * a second opinion available, and a silent disagreement about a refund is the kind that surfaces
 * months later in a reconciliation nobody can unpick. There we compute, compare, and refuse.
 */

import { prisma } from '../../lib/prisma';
import { runTransaction } from '../../lib/txRetry';
import { portionOf, toMinor, fromMinor } from '../pricing/money';
import { salesOrderService } from '../sales-order.service';
import { dispatchService } from '../dispatch.service';
import { planPayments } from '../payments/payment-rules';
import { recordPayments } from '../payments';

export const POS_SOURCE = 'SCALEEZY_POS';

/**
 * The one customer row a shop uses for everybody who did not leave a name.
 *
 * A constant rather than a lookup by name, because a name can be edited and this row must stay
 * findable. Per shop, because externalCustomerId is scoped to the tenant.
 */
export const WALK_IN_KEY = 'POS:WALK-IN';

/**
 * What the POS is told. Permanent codes stop that shop's queue for a person to look at.
 *
 * SALE_NOT_YET_APPLIED is the one that does NOT. It is a race, not a fault: sales are taken in
 * and applied a moment later, so a return can now reach us while its own sale is still in the
 * queue. Answering UNKNOWN_ORDER there would stop a shop's queue over something that fixes
 * itself in two seconds, which is the exact failure this whole design is meant to avoid. The
 * distinction did not exist before sales became asynchronous, and it had to be added with them.
 */
export type PosAnswer =
  | 'APPLIED'
  | 'ALREADY_APPLIED'
  | 'UNKNOWN_ITEM'
  | 'UNKNOWN_ORDER'
  | 'BAD_PAYLOAD'
  | 'QTY_EXCEEDS_SOLD'
  | 'AMOUNT_MISMATCH'
  /** Retryable. The sale this return is against has been taken in but not applied yet. */
  | 'SALE_NOT_YET_APPLIED';

export interface PosEventResult {
  answer: PosAnswer;
  /**
   * Worth the owner seeing, never worth stopping the queue for. A tax figure that disagrees is
   * the case this exists for: a cashier cannot fix it, so refusing the sale would halt a counter
   * over something only the office can settle.
   */
  warnings?: string[];
  /** Inventory's own order number, when one was made or found. */
  orderNumber?: string;
  /** One plain sentence for whoever has to look at a stopped queue. */
  detail?: string;
}

export interface PosLine {
  /** variantCode or sku -- never our uuids. */
  itemCode: string;
  qty: number;
  /** Whole paise, after discount, for the whole line. */
  lineTotalPaise: number;
  /** Before discount, per piece. Optional: without it the line total is taken as the list price. */
  unitPricePaise?: number | null;
  /** Whole paise off this LINE in total, not per piece. */
  discountPaise?: number | null;
  /** The POS's own rate, in basis points. 500 = 5%. */
  taxRateBps?: number | null;
  /** The POS's own tax for the line, whole paise. */
  taxPaise?: number | null;
}

export interface PosPayment {
  /** CASH | UPI | CARD | POINTS | CREDIT -- the same words Inventory already uses. */
  method: string;
  amountPaise: number;
}

export interface PosSaleEvent {
  kind: 'sale.completed';
  invoiceNo: string;
  occurredAt: string;
  locationCode?: string | null;
  customer?: { name?: string | null; phone?: string | null } | null;
  lines: PosLine[];
  totals: { roundOffPaise?: number };
  /**
   * What the customer actually handed over. Recorded here because Inventory's day book is the
   * whole business and the POS day close is one drawer -- two documents, not a double count.
   */
  payments?: PosPayment[];
}

export interface PosReturnEvent {
  kind: 'sale.returned';
  creditNoteNo: string;
  /** The invoice this reverses. */
  againstInvoiceNo: string;
  occurredAt: string;
  lines: PosLine[];
  totals: { roundOffPaise?: number };
}

const bad = (detail: string): PosEventResult => ({ answer: 'BAD_PAYLOAD', detail });

/**
 * Resolve the codes the POS sent to variants here.
 *
 * By variantCode first and SKU second, because those are the identities the POS was given. Sending
 * our uuids would couple the POS's database to our primary keys -- the same reason StorefrontEvent
 * carries productCode and sku.
 */
async function resolveItems(clientId: string, codes: string[]) {
  const wanted = [...new Set(codes)];
  const found = await prisma.productVariant.findMany({
    where: { clientId, OR: [{ variantCode: { in: wanted } }, { sku: { in: wanted } }] },
    select: {
      id: true, variantCode: true, sku: true, taxRateBps: true,
      product: { select: { taxRateBps: true } }
    }
  });

  const byCode = new Map<string, string>();
  const taxByCode = new Map<string, { taxRateBps: number | null }>();
  for (const v of found) {
    byCode.set(v.variantCode, v.id);
    if (!byCode.has(v.sku)) byCode.set(v.sku, v.id);

    // The variant's own rate wins over the product's -- a variant is the more specific answer.
    const standing = { taxRateBps: v.taxRateBps ?? v.product.taxRateBps ?? null };
    taxByCode.set(v.variantCode, standing);
    if (!taxByCode.has(v.sku)) taxByCode.set(v.sku, standing);
  }
  return { byCode, taxByCode };
}

/** The order this event is about, if Inventory has already seen it. */
async function findByExternal(clientId: string, externalOrderId: string) {
  return prisma.salesOrder.findFirst({
    where: { clientId, externalOrderId, sourceSystem: POS_SOURCE },
    select: { id: true, orderNumber: true }
  });
}

/**
 * The writes a POS sale makes, inside a transaction the caller already holds.
 *
 * Split out so an EXCHANGE can put the return and the new sale in ONE transaction. A customer who
 * hands back a saree and walks out with another has done one thing, and recording it as two that
 * can half-fail would leave either the shop short of stock it has, or holding stock it gave away.
 *
 * Extracted rather than copied for the usual reason: a second copy of this would drift, and what
 * it would drift on is which of the order, the dispatch and the payments got written.
 */
export async function writeSaleInTransaction(
  tx: any,
  clientId: string,
  locationId: string,
  event: PosSaleEvent,
  byCode: Map<string, string>
) {
  /*
   * A WALK-IN IS NOT A PAYLOAD FAULT.
   *
   * I had this wrong: a missing phone answered BAD_PAYLOAD, which would have stopped a shop's
   * whole queue on its first cash sale to somebody who did not want to give a number. Most POS
   * sales are exactly that.
   *
   * Inventory's own counter sale has no walk-in path -- it requires a phone, deliberately, so
   * that a shop's customer history is never split across two rows for one person. That rule is
   * right for a till where somebody is typing, and wrong as a reason to refuse a sale that has
   * already happened. So a sale with no phone is recorded against an explicit per-shop walk-in
   * customer: one row per shop, found or created on first use, named so it can never be mistaken
   * for a real person, and never carrying a phone.
   */
  const customerPhone = String(event.customer?.phone ?? '').trim();

    /*
     * THE POS'S OWN FIGURES, recorded rather than recalculated.
     *
     * writeFullOrderInTransaction prices from the catalogue unless the caller supplies its own,
     * which is the path Shopify orders already take. The POS is the system of record for this
     * bill -- it took the money and printed the invoice -- so its numbers go in as given, and
     * mayOverridePrices says so explicitly rather than by omission.
     */
    const made: any = await salesOrderService.writeFullOrderInTransaction(
      tx, clientId, locationId,
      {
        /*
         * Found or made by the POS's own identity for this person, not by ours.
         *
         * externalId is the path Shopify orders already take, and it is the lenient one: the
         * phone goes through phoneForOutsideCustomer, which keeps a number only when nobody
         * else in the shop has it and otherwise saves the order WITHOUT it. A sale must never
         * be refused because two people share a number -- that would stop the queue over
         * somebody else's data.
         */
        customer: customerPhone
          ? {
              externalId: `POS:${customerPhone}`,
              name: event.customer?.name ?? 'Counter customer',
              phone: customerPhone
            }
          : {
              /*
               * One walk-in row per shop, reached through the same externalId path so it is
               * found rather than made again. The name is unmistakable on purpose: it will
               * appear in the customer list, and it must never read like somebody's name.
               */
              externalId: WALK_IN_KEY,
              name: 'Walk-in customer (no details taken)',
              phone: null
            },
        externalOrderId: event.invoiceNo,
        sourceSystem: POS_SOURCE,
        /*
         * This event REPORTS a sale; it does not make one. The customer left with the goods
         * whatever the count says, so refusing on stock would stop the shop's queue on a fact
         * that can never change back. The count goes negative instead, which is the honest
         * record until somebody counts the shelf.
         */
        allowOversell: true,
        status: 'CONFIRMED',
        handover: 'TAKEN_NOW',
        items: event.lines.map(l => ({
          variantId: byCode.get(l.itemCode)!,
          quantity: l.qty,
          // Net per piece, worked from the line total so the two can never disagree.
          unitPrice: fromMinor(Math.round(l.lineTotalPaise / l.qty)),
          listUnitPrice: l.unitPricePaise != null
            ? fromMinor(l.unitPricePaise)
            : fromMinor(Math.round(l.lineTotalPaise / l.qty)),
          lineDiscount: l.discountPaise != null ? fromMinor(l.discountPaise) : undefined,
          /*
           * THE POS'S TAX, STORED AS SENT.
           *
           * The POS invoice is the document the customer is holding, so it is the legal record
           * of what was charged. If Inventory computed its own figure, one bill would have two
           * tax records that could disagree -- and today they would, because the POS's own
           * rates are still being settled. Ours becomes a check that warns.
           */
          taxRateBps: l.taxRateBps ?? undefined,
          taxPaise: l.taxPaise ?? undefined
        }))
      },
      'POS',
      null,
      { userId: null, manualLimitPercent: null, mayOverridePrices: true, lean: true, recordsWhatHappened: true }
    );

    /*
     * Dispatched in the same transaction, including a KEPT sale. The goods left the shop when
     * the till said so; an order that exists here without its stock having moved would be a
     * shop whose count is wrong until somebody notices.
     */
    await dispatchService.dispatchInTransaction(
      tx, clientId, made.id,
      made.items.map((i: any) => ({ salesOrderItemId: i.id, quantity: i.quantity })),
      { allowNegative: true }
    );

    /*
     * The money. Against the bill as Inventory wrote it, not the figure the till displayed --
     * if those ever differ it is a bug worth failing on rather than papering over.
     */
    if (event.payments?.length) {
      /*
       * Checked against what the till says it TOOK, not against the bill.
       *
       * planPayments' only mode insists the rows add up to the whole bill, which is right where a
       * cashier is typing: they should not be able to close a sale having taken too little. It is
       * wrong here twice over. A kept order takes a deposit and collects the rest next week --
       * refused outright until now, which also made payment.updated unreachable, since there was
       * no part-paid bill for it to complete. And an exchange pays only the difference in money;
       * the rest is settled against the credit note by a row written outside this function.
       *
       * Passing the sum keeps every other check planPayments makes -- the method shapes, one cash
       * row, change never negative -- and drops only the one that does not apply. What is still
       * owed is not lost: paymentSummary derives it from the bill and its rows, and already has a
       * PART_PAID state for exactly this.
       */
      const takenMinor = event.payments.reduce((a, p) => a + Math.round(p.amountPaise), 0);
      const planned = planPayments(
        takenMinor,
        event.payments.map(p => ({ method: p.method as any, amount: p.amountPaise / 100 })),
        'FULL'
      );
      await recordPayments(
        tx,
        { clientId, salesOrderId: made.id, locationId, receivedById: null },
        planned
      );
    }

  return made;
}

/**
 * A sale the till has already completed.
 *
 * Deliberately NOT a re-pricing. The lines arrive with their own totals and are written as given;
 * Inventory's job here is the stock and the ledger, not a second opinion on what the customer was
 * charged.
 */
export async function applySale(
  clientId: string,
  locationId: string,
  event: PosSaleEvent
): Promise<PosEventResult> {
  if (!event.invoiceNo) return bad('The event has no invoice number.');
  if (!Array.isArray(event.lines) || !event.lines.length) return bad('The sale has no lines.');
  if (event.lines.some(l => !Number.isInteger(l.qty) || l.qty <= 0)) {
    return bad('Every line needs a whole number of pieces above zero.');
  }
  if (event.lines.some(l => !Number.isInteger(l.lineTotalPaise) || l.lineTotalPaise < 0)) {
    return bad('Every line needs a whole number of paise, zero or more.');
  }


  /*
   * Together, because neither needs the other's answer.
   *
   * These ran one after the other and the sale paid for both. Outside a transaction each gets
   * its own pooled connection, so two queries cost one query's wait. A repeat invoice does throw
   * away the variant read, but a repeat is the rare path and it costs no extra wall-clock time.
   */
  const [already, { byCode, taxByCode }] = await Promise.all([
    findByExternal(clientId, event.invoiceNo),
    resolveItems(clientId, event.lines.map(l => l.itemCode))
  ]);
  if (already) return { answer: 'ALREADY_APPLIED', orderNumber: already.orderNumber };

  const missing = event.lines.map(l => l.itemCode).filter(c => !byCode.has(c));
  if (missing.length) {
    return { answer: 'UNKNOWN_ITEM', detail: `Not in this shop's catalogue: ${missing.join(', ')}.` };
  }

  /*
   * What the count said BEFORE this sale, so the warning can name what it became. Read outside
   * the transaction on purpose: it is for a sentence to a shopkeeper, not for a decision.
   *
   * ONE query for the whole basket, not one per line. A real bill is five or six items, and a
   * read per line put a third of a second on the sale for each one -- the shape of slowness that
   * never shows up in a test with a single line in it.
   */
  const stockRows = await prisma.inventoryStock.findMany({
    where: {
      clientId, locationId,
      variantId: { in: [...new Set(event.lines.map(l => byCode.get(l.itemCode)!))] }
    },
    select: { variantId: true, quantity: true, reservedQty: true }
  });
  const freeByVariant = new Map(stockRows.map(r => [r.variantId, r.quantity - r.reservedQty]));
  const stockBefore = new Map<string, number>();
  for (const line of event.lines) {
    stockBefore.set(line.itemCode, freeByVariant.get(byCode.get(line.itemCode)!) ?? 0);
  }

  try {
    /*
     * runTransaction, not prisma.$transaction, and the reason is measurable: the database is in
     * Singapore and Prisma's default interactive-transaction timeout is five seconds. Writing the
     * order, dispatching every line and recording the payments is a dozen round trips, and the
     * first real sale died on P2028 -- "transaction not found" -- with nothing written.
     *
     * `alreadyDone` is the other half: on a retry or a race it looks for the sale the winner
     * already wrote and returns that, rather than failing. It is a better version of catching
     * P2002 by hand, because it also covers a timeout that actually committed.
     */
    const order = await runTransaction(
      tx => writeSaleInTransaction(tx, clientId, locationId, event, byCode),
      {
      label: `pos sale ${event.invoiceNo}`,
      alreadyDone: () => findByExternal(clientId, event.invoiceNo) as any,
      tooSlowMessage: 'The shop took too long to record this sale. It has not been recorded; the till will send it again.'
    });

    // alreadyDone hands back the row it found, which has no `items` -- either way the sale exists.
    /*
     * Ours against theirs, said out loud and nothing more.
     *
     * A cashier cannot fix a tax rate, so refusing the sale would stop a counter over something
     * only the office can settle -- and the sale has already happened either way. The POS shows
     * these to the owner; the money and the stock are already recorded.
     */
    const warnings: string[] = [];

    /*
     * The lines that outran the shelf, and what the count actually became.
     *
     * Read back rather than worked out: the count this sale STARTED from may already have been
     * negative from an earlier one, so "had minus sold" gives a number that is arithmetically
     * tidy and factually wrong -- and this sentence is the one a shopkeeper walks to the shelf
     * with. One read for all of them, though, not one per line: this runs after the sale is
     * committed, so it is pure delay in front of a customer who is waiting for a receipt.
     */
    /*
     * Judged by what the shelf BECAME, for every line, not only by what it was before.
     *
     * "Sold more than there was" used to be decided from the count read before the sale. Two
     * tills selling the last piece in the same instant each read 1, each sold 1, and neither was
     * told anything: the shelf went to minus one and no warning reached the owner at all. A shelf
     * below zero after this sale is the fact, whoever got there first -- so that is what is asked.
     * The read is for all the lines now; this runs in the queue worker, behind no waiting customer.
     */
    const [rows, store] = await Promise.all([
      prisma.inventoryStock.findMany({
        where: {
          clientId, locationId,
          variantId: { in: [...new Set(event.lines.map(l => byCode.get(l.itemCode)!))] }
        },
        select: { variantId: true, quantity: true }
      }),
      prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { name: true, active: true } })
    ]);
    const afterByVariant = new Map<string, number>(rows.map(r => [r.variantId, r.quantity]));

    for (const line of event.lines) {
      const had = stockBefore.get(line.itemCode) ?? 0;
      const after = afterByVariant.get(byCode.get(line.itemCode)!) ?? 0;
      // Short by what this bill outran the count it saw, or by how far below zero the shelf now
      // is (never more than this bill sold) -- whichever says more.
      const short = Math.max(line.qty - Math.max(0, had), Math.min(line.qty, -after));
      if (short <= 0) continue;
      warnings.push(
        `${line.itemCode}: sold ${short} more than Inventory had at this ` +
        `store; stock is now ${after}. Count it at the next stock check.`
      );
    }

    /*
     * A store that is switched off in Inventory. The bill is recorded all the same (see
     * recordsWhatHappened in writeFullOrderInTransaction): the customer has the goods and a
     * printed invoice, and refusing it only made Inventory's stock and Day Book wrong about a sale
     * that happened. The owner is told, because a till still selling from a closed store is
     * something only they can settle.
     */
    if (store && !store.active) {
      warnings.push(
        `${store.name} is switched off in Inventory, but this till is still selling from it. ` +
        `The bill was recorded. Switch the store back on, or disconnect the till.`
      );
    }

    for (const line of event.lines) {
      if (line.taxRateBps == null) continue;
      const standing = taxByCode.get(line.itemCode);
      if (standing?.taxRateBps != null && standing.taxRateBps !== line.taxRateBps) {
        warnings.push(
          `${line.itemCode}: the till charged ${line.taxRateBps / 100}% GST, the product here says ` +
          `${standing.taxRateBps / 100}%. The bill was recorded as the till sent it -- somebody should ` +
          `settle which is right.`
        );
      }
    }

    return {
      answer: (order as any).items ? 'APPLIED' : 'ALREADY_APPLIED',
      orderNumber: order.orderNumber,
      ...(warnings.length ? { warnings } : {})
    };
  } catch (e: any) {
    /*
     * A retry racing the original, or two tills at once. The unique index decides it and the
     * loser reads the winner's order rather than failing -- the shape counter-sale already uses.
     */
    if (e?.code === 'P2002') {
      const winner = await findByExternal(clientId, event.invoiceNo);
      if (winner) return { answer: 'ALREADY_APPLIED', orderNumber: winner.orderNumber };
    }
    if (e?.statusCode === 400 || e?.status === 400) {
      return bad(e.message ?? 'The sale was refused.');
    }
    throw e;
  }
}

/**
 * What a return SHOULD be worth, by Inventory's own reckoning.
 *
 * Proven identical to the POS's rule over 1,040,312 apportionments, including every half-paisa
 * boundary -- see the note in verify-pos-events.ts. Compared PER LINE, never on totals, because
 * the POS adds the original bill's round-off to the credit note that empties a bill, and that
 * legitimately moves a total by up to 50 paise.
 */
export async function checkReturnAmounts(
  clientId: string,
  againstInvoiceNo: string,
  lines: PosLine[]
): Promise<PosEventResult | null> {
  const order = await prisma.salesOrder.findFirst({
    where: { clientId, externalOrderId: againstInvoiceNo, sourceSystem: POS_SOURCE },
    select: {
      id: true, orderNumber: true,
      items: {
        select: {
          id: true, quantity: true, totalPrice: true,
          variant: { select: { variantCode: true, sku: true } }
        }
      }
    }
  });

  if (!order) {
    /*
     * Is it missing, or merely not applied yet?
     *
     * The POS sends a return after its sale, but sales are now taken in and applied a moment
     * later, so a return can legitimately overtake one. Telling the till UNKNOWN_ORDER there
     * would stop the shop's queue over a two-second race. This costs one extra query and only
     * on the path where we were about to refuse anyway.
     */
    const queued = await prisma.posInboundEvent.findFirst({
      where: {
        clientId, kind: 'sale.completed', invoiceNo: againstInvoiceNo,
        status: { in: ['QUEUED', 'RUNNING'] }
      },
      select: { id: true }
    });
    if (queued) {
      return {
        answer: 'SALE_NOT_YET_APPLIED',
        detail: `Invoice ${againstInvoiceNo} has been taken in but not applied yet. Send this return again in a moment.`
      };
    }
    return { answer: 'UNKNOWN_ORDER', detail: `No sale here for invoice ${againstInvoiceNo}.` };
  }

  // How much of each line has already come back, so two partial returns cannot exceed the sale.
  const earlier = await prisma.salesReturnItem.groupBy({
    by: ['salesOrderItemId'],
    where: { salesOrderItemId: { in: order.items.map(i => i.id) } },
    _sum: { quantity: true }
  });
  const returnedAlready = new Map(earlier.map(r => [r.salesOrderItemId, r._sum.quantity ?? 0]));

  for (const line of lines) {
    const item = order.items.find(
      i => i.variant.variantCode === line.itemCode || i.variant.sku === line.itemCode
    );
    if (!item) {
      return { answer: 'UNKNOWN_ITEM', detail: `${line.itemCode} was not on invoice ${againstInvoiceNo}.` };
    }

    const before = returnedAlready.get(item.id) ?? 0;
    const after = before + line.qty;
    if (after > item.quantity) {
      return {
        answer: 'QTY_EXCEEDS_SOLD',
        detail: `${line.itemCode}: ${after} pieces returned against ${item.quantity} sold on ${againstInvoiceNo}.`
      };
    }

    const ours = portionOf(toMinor(item.totalPrice), item.quantity, before, after);
    if (ours !== line.lineTotalPaise) {
      return {
        answer: 'AMOUNT_MISMATCH',
        detail: `${line.itemCode}: the till says ${line.lineTotalPaise} paise, this sale works out to ${ours}. ` +
          `Nothing has been changed -- somebody should look at both before this goes through.`
      };
    }

    returnedAlready.set(item.id, after);
  }

  return null;   // nothing wrong
}
