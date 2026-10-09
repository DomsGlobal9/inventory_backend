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
import { POS_SOURCE, dateFromTill, type PosEventResult, type PosLine } from './pos-events.service';

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
  /** The largest part, when a refund was split. CASH when the till does not say. */
  refund?: { method?: string; reference?: string } | null;
  /** Every part of a split refund. A till can give half back on UPI and half in cash. */
  refunds?: { method?: string; amountPaise?: number; reference?: string }[] | null;
  /** The till's round-off on this credit note, as on sale.completed. */
  totals?: { roundOffPaise?: number } | null;
  note?: string;
  /** When the till took it back: dates the return and its refund (dateFromTill). */
  occurredAt?: string;
};

/**
 * A split refund, merged by method and only if it adds up.
 *
 * Merged, because two rows of the same method would each try to post store credit under the same
 * once-key. Only if it adds up, because the alternative is books whose refund rows and whose
 * return total disagree -- and a shop reconciling a drawer at closing time cannot tell which of
 * the two lied. When it does not add up we fall back to one row and say so, which is wrong in a
 * way somebody can see rather than wrong in a way they cannot.
 */
function splitOf(event: PosReturnEvent, moneyMinor: number, roundOffs: number[] = []) {
  const raw = Array.isArray(event.refunds) ? event.refunds : [];
  if (!raw.length) return null;

  const byMethod = new Map<RefundMethod, { amount: number; reference: string | null }>();
  for (const r of raw) {
    const m = String(r?.method ?? '').toUpperCase();
    if (!(METHODS as string[]).includes(m)) return null;
    const amount = Number(r?.amountPaise);
    if (!Number.isInteger(amount) || amount <= 0) return null;
    const at = byMethod.get(m as RefundMethod);
    const reference = typeof r?.reference === 'string' ? r.reference.trim().slice(0, 100) || null : null;
    if (at) { at.amount += amount; at.reference = at.reference ?? reference; }
    else byMethod.set(m as RefundMethod, { amount, reference });
  }

  const total = [...byMethod.values()].reduce((a, x) => a + x.amount, 0);
  /*
   * Off by exactly the bill's round-off: expected, and the till is right. Inventory's figure comes
   * from the line totals, which round-off never touched; the paise rounded away never changed hands,
   * so the money that really went back is the till's. Recorded as the till sent it, no warning.
   */
  const roundedAway = roundOffs.some(r => r !== 0 && Math.abs(total - moneyMinor) === Math.abs(r));
  if (total !== moneyMinor && !roundedAway) return { mismatch: total, parts: [] as const };

  return {
    mismatch: null,
    parts: [...byMethod.entries()].map(([method, x]) => ({ method, ...x }))
  };
}

/**
 * Which dispatch row each returned item belongs to, and whether it can still come back.
 *
 * Shared with the exchange, which returns pieces exactly the way a return does and then sells
 * others in the same breath.
 */
export async function planReturnLines(
  clientId: string,
  againstInvoiceNo: string,
  lines: PosLine[],
  creditNoteNo: string
) {
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
    return { ok: false as const, result: { answer: 'UNKNOWN_ORDER' as const, detail: `No sale here for invoice ${againstInvoiceNo}.` } };
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
        ok: false as const,
        result: {
          answer: 'QTY_EXCEEDS_SOLD' as const,
          detail: `${line.itemCode}: ${line.qty} coming back on ${creditNoteNo}, but only ${line.qty - left} of that bill ${line.qty - left === 1 ? 'is' : 'are'} still returnable.`
        }
      };
    }
  }

  return { ok: true as const, order, taking };
}

/**
 * The writes a POS return makes, inside a transaction the caller already holds.
 *
 * Split out so an EXCHANGE can put the return and the new sale in ONE transaction. Handing a
 * saree back and walking out with another is one act; recorded as two that can half-fail it
 * leaves the shop either short of stock it has or holding stock it gave away.
 */
export async function writeReturnInTransaction(tx: any, p: {
  clientId: string;
  order: { id: string; customerId: string | null };
  taking: { dispatchItemId: string; quantity: number }[];
  key: string;
  returnLocationId: string;
  method: RefundMethod;
  reference: string | null;
  creditNoteNo: string;
  event: PosReturnEvent;
  warnings: string[];
  note?: string;
}) {
  const { clientId, order, taking, key, returnLocationId, method, reference, creditNoteNo, event, warnings } = p;

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
    // The round-offs this money may differ by: the credit note's own, and the bill it reverses.
    const sold = await tx.posInboundEvent.findFirst({
      where: { clientId, invoiceNo: event.againstInvoiceNo ?? '', kind: 'sale.completed' },
      select: { payload: true }
    });
    const roundOffs = [Number(event.totals?.roundOffPaise ?? 0), Number((sold?.payload as any)?.totals?.roundOffPaise ?? 0)]
      .filter(n => Number.isInteger(n));
    const split = splitOf(event, moneyMinor, roundOffs);

    if (split?.mismatch != null) {
      warnings.push(
        `${creditNoteNo}: the till says it gave back ${(split.mismatch / 100).toFixed(2)} across its ` +
        `methods, this return comes to ${(moneyMinor / 100).toFixed(2)}. Recorded as one ` +
        `${method.toLowerCase()} refund of the second figure -- somebody should settle which is right.`
      );
    }

    if (split?.parts.length) {
      /*
       * Exactly how the till gave it back, one row per method.
       *
       * No creditShare here, and that is deliberate: creditShare decides how much SHOULD go
       * back as store credit when the bill was partly paid with it. The till has already
       * handed the money over in whatever form it chose, and inventing a different split
       * afterwards would put rows in the books describing something that did not happen.
       */
      let biggest = -1;
      let headline: RefundMethod | null = null;
      for (const part of split.parts) {
        await writeRefund(tx, {
          clientId, orderId: order.id, returnId: created.id, returnNumber: done.returnNumber,
          locationId: returnLocationId, customerId: order.customerId ?? null,
          moneyMinor: part.amount, creditBackMinor: 0, method: part.method,
          reference: part.reference, userId: null
        });
        if (part.amount > biggest) { biggest = part.amount; headline = part.method; }
      }
      await tx.salesReturn.update({
        where: { id: created.id },
        data: { refundStatus: 'REFUNDED', refundMethod: headline, refundedAt: new Date() }
      });
    } else {
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
  }

  await dateFromTill(tx, event.occurredAt, { returnId: created.id });
  return created.id;
}

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

  const planned = await planReturnLines(clientId, againstInvoiceNo, lines, creditNoteNo);
  if (!planned.ok) return planned.result;
  const { order, taking } = planned;

  const wanted = String(event.refund?.method ?? 'CASH').toUpperCase();
  const method: RefundMethod = (METHODS as string[]).includes(wanted) ? wanted as RefundMethod : 'CASH';
  const reference = typeof event.refund?.reference === 'string'
    ? event.refund.reference.trim().slice(0, 100) || null
    : null;

  const returnLocationId = locationId || order.locationId;
  const warnings: string[] = [];

  const returnId = await runTransaction(
    tx => writeReturnInTransaction(tx, {
      clientId, order, taking, key, returnLocationId, method, reference, creditNoteNo, event, warnings
    }),
    {
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
    ...(warnings.length ? { warnings } : {}),
    detail: `${creditNoteNo} taken back against ${order.orderNumber} as ${out.returnNumber}: ` +
      `${Number(out.refundTotal).toFixed(2)} back${out.refundMethod ? ` by ${String(out.refundMethod).toLowerCase()}` : ''}.`
  };
}
