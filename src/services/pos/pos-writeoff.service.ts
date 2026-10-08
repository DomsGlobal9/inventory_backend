/**
 * Udhaar the shop gave up on: the till's write-off of a bill that went home unpaid.
 *
 * NOT MONEY. No payment row is written, so takings, the Day Book and the drawer never see it --
 * nothing came in. The order keeps the amount, the reason, who approved it and when, and its due
 * drops by that much. The GST invoice is untouched: it was issued and stays issued.
 *
 * Paid after all: an ordinary payment.updated, which takes back that much of the write-off
 * (pos-payments), so the bill never reads as overpaid. The written-off part never earned points.
 *
 * ONCE per idempotencyKey: the event row is unique on it, and the order remembers the last key it
 * applied, so a retry after a lost answer changes nothing.
 */
import { prisma } from '../../lib/prisma';
import { runTransaction } from '../../lib/txRetry';
import { fromMinor, toMinor } from '../pricing';
import { POS_SOURCE, type PosEventResult } from './pos-events.service';
import { outstanding } from './pos-payments.service';

export type PosWriteOffEvent = {
  invoiceNo?: string;
  idempotencyKey?: string;
  occurredAt?: string;
  amountPaise?: number;
  reason?: string;
  by?: string;
};

export function faultInWriteOffShape(event: PosWriteOffEvent): string | null {
  if (!event?.invoiceNo) return 'The write-off does not say which bill it is for.';
  const key = typeof event.idempotencyKey === 'string' ? event.idempotencyKey.trim() : '';
  if (!key || key.length > 120) return 'The write-off needs an idempotencyKey, up to 120 characters.';
  if (!Number.isInteger(event.amountPaise) || (event.amountPaise as number) <= 0) {
    return 'amountPaise must be a whole number of paise above zero: what is being written off.';
  }
  if (typeof event.reason !== 'string' || !event.reason.trim()) return 'Say why the bill is written off, in "reason".';
  return null;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function applyWriteOff(clientId: string, _locationId: string, event: PosWriteOffEvent): Promise<PosEventResult> {
  const fault = faultInWriteOffShape(event);
  if (fault) return { answer: 'BAD_PAYLOAD', detail: fault };
  const invoiceNo = String(event.invoiceNo);
  const key = String(event.idempotencyKey).trim();
  const order = await prisma.salesOrder.findFirst({
    where: { clientId, externalOrderId: invoiceNo, sourceSystem: POS_SOURCE, deletedAt: null },
    select: { id: true, orderNumber: true, writtenOffKey: true }
  });
  if (!order) return { answer: 'UNKNOWN_ORDER', detail: `No sale here for invoice ${invoiceNo}.` };
  if (order.writtenOffKey === key) return { answer: 'ALREADY_APPLIED', orderNumber: order.orderNumber, detail: `${key} was already written off on ${order.orderNumber}.` };

  const at = event.occurredAt ? new Date(event.occurredAt) : new Date();
  const amount = event.amountPaise as number;
  return runTransaction(async tx => {
    // Locked, so a collection landing at the same moment is counted before or after, never half.
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${order.id} FOR UPDATE`;
    const due = await outstanding(tx, order.id);
    if (due <= 0) {
      return { answer: 'NOTHING_DUE' as const, orderNumber: order.orderNumber, detail: `${order.orderNumber} has nothing due here, so nothing was written off.` };
    }
    const now = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { writtenOff: true } });
    const off = Math.min(amount, due);
    await tx.salesOrder.update({
      where: { id: order.id },
      data: {
        writtenOff: fromMinor(toMinor(now.writtenOff as any) + off),
        writtenOffReason: event.reason!.trim().slice(0, 500),
        writtenOffBy: typeof event.by === 'string' ? event.by.trim().slice(0, 120) || null : null,
        writtenOffAt: Number.isNaN(at.getTime()) ? new Date() : at,
        writtenOffKey: key
      }
    });
    return {
      answer: 'APPLIED' as const,
      orderNumber: order.orderNumber,
      detail: `${rupees(off)} written off on ${order.orderNumber}. ${due - off > 0 ? `${rupees(due - off)} still due.` : 'Nothing due.'}`,
      warnings: amount !== due ? [`The till wrote off ${rupees(amount)}; Inventory showed ${rupees(due)} due, so ${rupees(off)} was written off.`] : undefined
    };
  }, { label: `pos write-off ${key}`, tooSlowMessage: 'The shop took too long to record this write-off. It has not been recorded; the till will send it again.' });
}
