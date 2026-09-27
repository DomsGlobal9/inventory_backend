/**
 * A return the till has already given the money back for.
 *
 * WHY THIS IS NOT A SECOND RETURN SYSTEM. Everything below goes through the same
 * createReturnIn / completeReturnIn / writeRefund the counter uses. A return decides how much of
 * a refund goes back as store credit rather than cash, how points come back, and what the Day
 * Book shows -- and two implementations of that is one rule and one slow divergence that surfaces
 * in somebody's books months later. The POS path supplies different INPUTS to the same machinery:
 * no person pressed the button, the money is already gone, and the pieces named arrive as item
 * codes rather than as rows a cashier clicked.
 *
 * WHAT THE POS DECIDES AND WE DO NOT. Whether the return was allowed. The manager limit, the
 * return window and the "is this within policy" questions belong to whoever is standing in front
 * of the customer, and by the time this event arrives the customer has their money. Refusing here
 * would leave the shop's books disagreeing with its till and change nothing about what happened.
 * We check the ARITHMETIC, which is the one thing a till cannot check for itself, and that
 * happens before this is ever called -- see checkReturnAmounts.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { runTransaction } from '../../lib/txRetry';
import { toMinor } from '../pricing';
import { returnService } from '../return.service';
import { writeRefund, creditShare, type RefundMethod } from '../counter-return/counter-return.service';
import { POS_SOURCE, type PosEventResult, type PosLine } from './pos-events.service';

const METHODS: RefundMethod[] = ['CASH', 'UPI', 'CARD', 'CREDIT'];

/**
 * One return per credit note, enforced by the database rather than by looking first.
 *
 * counterKey is globally unique, so a worker that crashed after committing and then retried finds
 * the constraint instead of refunding the customer twice. Prefixed, because the counter puts its
 * own uuid in this column and the two must never be able to collide.
 */
const keyFor = (clientId: string, creditNoteNo: string) => `POS:${clientId}:${creditNoteNo}`;

export type PosReturnEvent = {
  creditNoteNo?: string;
  againstInvoiceNo?: string;
  lines?: PosLine[];
  /** How the money actually went back at the till. CASH when the till does not say. */
  refund?: { method?: string; reference?: string } | null;
  note?: string;
};

/**
 * Apply a return that has already happened.
 *
 * Assumes checkReturnAmounts has passed: the invoice is here, every line was on it, no line
 * returns more than was sold, and our arithmetic agrees with the till's to the paisa.
 */
export async function applyReturn(
  clientId: string,
  locationId: string,
  event: PosReturnEvent
): Promise<PosEventResult> {
  const creditNoteNo = String(event.creditNoteNo ?? '').trim();
  const againstInvoiceNo = String(event.againstInvoiceNo ?? '').trim();
  if (!creditNoteNo) return { answer: 'BAD_PAYLOAD', detail: 'The return has no credit note number.' };
  if (!againstInvoiceNo) return { answer: 'BAD_PAYLOAD', detail: 'The return does not say which bill it is against.' };

  const lines = Array.isArray(event.lines) ? event.lines : [];
  if (!lines.length) return { answer: 'BAD_PAYLOAD', detail: 'The return has no lines.' };

  const key = keyFor(clientId, creditNoteNo);

  // The same credit note again: the return the first attempt made, not a second one.
  const already = await prisma.salesReturn.findUnique({
    where: { counterKey: key },
    select: { id: true, returnNumber: true }
  });
  if (already) {
    return {
      answer: 'ALREADY_APPLIED',
      orderNumber: already.returnNumber,
      detail: `Credit note ${creditNoteNo} was already taken back as ${already.returnNumber}.`
    };
  }

  /*
   * The bill, and which dispatch row each returned item belongs to.
   *
   * The POS names pieces by variantCode or sku; a return is recorded against the DISPATCH item,
   * because that is the row that knows how many actually went out of the door and how many have
   * already come back. Matching on the sale line instead would let a bill dispatched twice have
   * its return applied against the wrong half.
   */
  const order = await prisma.salesOrder.findFirst({
    where: { clientId, externalOrderId: againstInvoiceNo, sourceSystem: POS_SOURCE, deletedAt: null },
    select: {
      id: true, orderNumber: true, customerId: true, locationId: true,
      dispatches: {
        select: {
          items: {
            select: {
              id: true, quantity: true, returnedQty: true,
              returnItems: {
                where: { salesReturn: { status: { in: ['REQUESTED', 'RECEIVED', 'INSPECTED'] } } },
                select: { quantity: true }
              },
              salesOrderItem: {
                select: { variant: { select: { variantCode: true, sku: true } } }
              }
            }
          }
        }
      }
    }
  });

  if (!order) {
    return { answer: 'UNKNOWN_ORDER', detail: `No sale here for invoice ${againstInvoiceNo}.` };
  }

  const dispatchLines = order.dispatches.flatMap(d => d.items.map(i => ({
    dispatchItemId: i.id,
    variantCode: i.salesOrderItem.variant.variantCode,
    sku: i.salesOrderItem.variant.sku,
    free: Math.max(0, i.quantity - i.returnedQty - i.returnItems.reduce((s, r) => s + r.quantity, 0))
  })));

  /*
   * Spread across dispatch rows, because one bill can have gone out in two parcels.
   *
   * Two pieces of the same saree can sit on two dispatch rows with one free each, and a return of
   * two would not fit on either alone. Taking what each row can still give, in order, is what the
   * counter screen does when a cashier ticks the same item twice.
   */
  const taking: { dispatchItemId: string; quantity: number }[] = [];
  for (const line of lines) {
    let left = line.qty;
    for (const d of dispatchLines) {
      if (left <= 0) break;
      if (d.variantCode !== line.itemCode && d.sku !== line.itemCode) continue;
      const take = Math.min(left, d.free);
      if (take <= 0) continue;
      taking.push({ dispatchItemId: d.dispatchItemId, quantity: take });
      d.free -= take;
      left -= take;
    }
    if (left > 0) {
      return {
        answer: 'QTY_EXCEEDS_SOLD',
        detail: `${line.itemCode}: ${line.qty} coming back on ${creditNoteNo}, but only ${line.qty - left} of that bill ${line.qty - left === 1 ? 'is' : 'are'} still returnable.`
      };
    }
  }

  const wanted = String(event.refund?.method ?? 'CASH').toUpperCase();
  const method: RefundMethod = (METHODS as string[]).includes(wanted) ? wanted as RefundMethod : 'CASH';
  const reference = typeof event.refund?.reference === 'string'
    ? event.refund.reference.trim().slice(0, 100) || null
    : null;

  const returnLocationId = locationId || order.locationId;

  const returnId = await runTransaction(async tx => {
    const created = await returnService.createReturnIn(
      tx, clientId, order.id, taking,
      event.note ? String(event.note).slice(0, 500) : `POS credit note ${creditNoteNo}`,
      'OTHER'
    );

    /*
     * Everything goes back on sale. The till has no "damaged" tick in the event, and a piece
     * handed back over a counter is on the shelf again by the time this arrives -- so RESTOCK is
     * what actually happened. When the POS grows a condition field this is where it lands.
     */
    for (const item of created.items) {
      await tx.salesReturnItem.update({ where: { id: item.id }, data: { disposition: 'RESTOCK' } });
    }

    await tx.salesReturn.update({
      where: { id: created.id },
      data: { status: 'INSPECTED', atCounter: true, counterKey: key, locationId: returnLocationId }
    });

    // Puts the pieces back and works out what the refund comes to.
    await returnService.completeReturnIn(tx, clientId, created.id, { restockAt: returnLocationId });

    const done = await tx.salesReturn.findUniqueOrThrow({
      where: { id: created.id },
      select: { refundTotal: true, returnNumber: true }
    });

    const moneyMinor = toMinor(done.refundTotal as any);
    if (moneyMinor > 0) {
      const creditBackMinor = await creditShare(tx, clientId, order.id, moneyMinor, created.id);
      const recorded = await writeRefund(tx, {
        clientId, orderId: order.id, returnId: created.id, returnNumber: done.returnNumber,
        locationId: returnLocationId, customerId: order.customerId ?? null,
        moneyMinor, creditBackMinor, method, reference,
        // No person did this. receivedById is nullable precisely for a machine.
        userId: null
      });
      await tx.salesReturn.update({
        where: { id: created.id },
        data: { refundStatus: 'REFUNDED', refundMethod: recorded, refundedAt: new Date() }
      });
    }

    return created.id;
  }, {
    label: 'take a POS return back',
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    tooSlowMessage: 'Taking this return back took too long, so nothing was recorded. Send it again.',
    // A retry after a lost answer finds the return the first attempt made.
    alreadyDone: async () =>
      (await prisma.salesReturn.findUnique({ where: { counterKey: key }, select: { id: true } }))?.id ?? null
  });

  const out = await prisma.salesReturn.findUniqueOrThrow({
    where: { id: returnId },
    select: { returnNumber: true, refundTotal: true, refundMethod: true }
  });

  return {
    answer: 'APPLIED',
    orderNumber: out.returnNumber,
    detail: `${creditNoteNo} taken back against ${order.orderNumber} as ${out.returnNumber}: ` +
      `${Number(out.refundTotal).toFixed(2)} back${out.refundMethod ? ` by ${String(out.refundMethod).toLowerCase()}` : ''}.`
  };
}
