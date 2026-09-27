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

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { portionOf, toMinor } from '../pricing/money';

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
}

export interface PosSaleEvent {
  kind: 'sale.completed';
  invoiceNo: string;
  occurredAt: string;
  locationCode?: string | null;
  customer?: { name?: string | null; phone?: string | null } | null;
  lines: PosLine[];
  totals: { roundOffPaise?: number };
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
  event: PosSaleEvent,
  deps: {
    writeOrder: (tx: Prisma.TransactionClient, input: any) => Promise<{ id: string; orderNumber: string }>;
    dispatchAll: (tx: Prisma.TransactionClient, orderId: string) => Promise<void>;
  }
): Promise<PosEventResult> {
  if (!event.invoiceNo) return bad('The event has no invoice number.');
  if (!Array.isArray(event.lines) || !event.lines.length) return bad('The sale has no lines.');
  if (event.lines.some(l => !Number.isInteger(l.qty) || l.qty <= 0)) {
    return bad('Every line needs a whole number of pieces above zero.');
  }

  const already = await findByExternal(clientId, event.invoiceNo);
  if (already) {
    return { answer: 'ALREADY_APPLIED', orderNumber: already.orderNumber };
  }

  const byCode = await resolveItems(clientId, event.lines.map(l => l.itemCode));
  const missing = event.lines.map(l => l.itemCode).filter(c => !byCode.has(c));
  if (missing.length) {
    return { answer: 'UNKNOWN_ITEM', detail: `Not in this shop's catalogue: ${missing.join(', ')}.` };
  }

  try {
    const order = await prisma.$transaction(async tx => {
      const made = await deps.writeOrder(tx, {
        clientId,
        externalOrderId: event.invoiceNo,
        sourceSystem: POS_SOURCE,
        customer: event.customer ?? undefined,
        lines: event.lines.map(l => ({
          variantId: byCode.get(l.itemCode)!,
          quantity: l.qty,
          lineTotalMinor: l.lineTotalPaise
        }))
      });
      // One transaction, so a sale never exists without its stock having moved.
      await deps.dispatchAll(tx, made.id);
      return made;
    });

    return { answer: 'APPLIED', orderNumber: order.orderNumber };
  } catch (e: any) {
    /*
     * Two tills, or a retry racing the original. The unique index is what decides it, and the
     * loser reads the winner's order rather than failing -- the same shape counter-sale.service
     * already uses for two presses landing together.
     */
    if (e?.code === 'P2002') {
      const winner = await findByExternal(clientId, event.invoiceNo);
      if (winner) return { answer: 'ALREADY_APPLIED', orderNumber: winner.orderNumber };
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
