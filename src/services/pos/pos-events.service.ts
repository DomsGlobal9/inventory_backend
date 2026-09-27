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

/** What the POS is told. Permanent codes stop that shop's queue for a person to look at. */
export type PosAnswer =
  | 'APPLIED'
  | 'ALREADY_APPLIED'
  | 'UNKNOWN_ITEM'
  | 'UNKNOWN_ORDER'
  | 'BAD_PAYLOAD'
  | 'QTY_EXCEEDS_SOLD'
  | 'AMOUNT_MISMATCH';

export interface PosEventResult {
  answer: PosAnswer;
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
    select: { id: true, variantCode: true, sku: true }
  });
  const byCode = new Map<string, string>();
  for (const v of found) {
    byCode.set(v.variantCode, v.id);
    if (!byCode.has(v.sku)) byCode.set(v.sku, v.id);
  }
  return byCode;
}

/** The order this event is about, if Inventory has already seen it. */
async function findByExternal(clientId: string, externalOrderId: string) {
  return prisma.salesOrder.findFirst({
    where: { clientId, externalOrderId, sourceSystem: POS_SOURCE },
    select: { id: true, orderNumber: true }
  });
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
   * The POS's own rule is that a phone is mandatory and unique per shop, so a sale without one is
   * a payload fault rather than a walk-in. Said plainly rather than refused with "choose the
   * customer", which is a sentence written for somebody looking at a screen.
   */
  const customerPhone = String(event.customer?.phone ?? '').trim();
  if (!customerPhone) {
    return bad('This sale has no customer phone number, and Inventory records every sale against one.');
  }

  const already = await findByExternal(clientId, event.invoiceNo);
  if (already) return { answer: 'ALREADY_APPLIED', orderNumber: already.orderNumber };

  const byCode = await resolveItems(clientId, event.lines.map(l => l.itemCode));
  const missing = event.lines.map(l => l.itemCode).filter(c => !byCode.has(c));
  if (missing.length) {
    return { answer: 'UNKNOWN_ITEM', detail: `Not in this shop's catalogue: ${missing.join(', ')}.` };
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
    const order = await runTransaction(async tx => {
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
          customer: {
            externalId: `POS:${customerPhone}`,
            name: event.customer?.name ?? 'Counter customer',
            phone: customerPhone
          },
          externalOrderId: event.invoiceNo,
          sourceSystem: POS_SOURCE,
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
            lineDiscount: l.discountPaise != null ? fromMinor(l.discountPaise) : undefined
          }))
        },
        'POS',
        null,
        { userId: null, manualLimitPercent: null, mayOverridePrices: true, lean: true }
      );

      /*
       * Dispatched in the same transaction, including a KEPT sale. The goods left the shop when
       * the till said so; an order that exists here without its stock having moved would be a
       * shop whose count is wrong until somebody notices.
       */
      await dispatchService.dispatchInTransaction(
        tx, clientId, made.id,
        made.items.map((i: any) => ({ salesOrderItemId: i.id, quantity: i.quantity }))
      );

      /*
       * The money. Against the bill as Inventory wrote it, not the figure the till displayed --
       * if those ever differ it is a bug worth failing on rather than papering over.
       */
      if (event.payments?.length) {
        const planned = planPayments(
          toMinor(made.total),
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
    }, {
      label: `pos sale ${event.invoiceNo}`,
      alreadyDone: () => findByExternal(clientId, event.invoiceNo) as any,
      tooSlowMessage: 'The shop took too long to record this sale. It has not been recorded; the till will send it again.'
    });

    // alreadyDone hands back the row it found, which has no `items` -- either way the sale exists.
    return {
      answer: (order as any).items ? 'APPLIED' : 'ALREADY_APPLIED',
      orderNumber: order.orderNumber
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
