import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { runTransaction } from '../../lib/txRetry';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { planPayments, paymentSummary } from '../payments/payment-rules';
import { toMinor, fromMinor } from '../pricing/money';

/**
 * MONEY COLLECTED LATER, RECORDED IN INVENTORY.
 *
 * An online-shop order paid on delivery, or an order typed in by hand, had no way to be marked paid:
 * payments came only from the till and from Razorpay, so the Orders page called them due forever
 * (sphl, ₹25,099 on 23 Oct). This writes the money the shop collected against the order, on the day it
 * is recorded, at the order's store -- which is how the Day Book counts money in.
 *
 * Not for a POS till bill: its balance is taken on the till (payment.updated), and recording it here as
 * well would be a second copy the till never hears of. Not for Shopify (paid on Shopify), nor for a
 * cancelled or draft order (nothing is owed).
 *
 * Once only: the screen sends a key per attempt, so a double tap or a retry after a lost answer records
 * the money once. The order is locked while its due is worked out, so two people collecting at once
 * cannot take more than is owed.
 */

const METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'] as const;

export const collectBody = z.object({
  method: z.enum(METHODS),
  amount: z.number().positive().max(1e9),
  cashReceived: z.number().positive().max(1e9).nullish(),
  reference: z.string().max(40).nullish(),
  key: z.string().min(8).max(80)
});
export type CollectBody = z.infer<typeof collectBody>;

const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whether money may be recorded against this order here, and if not, why -- in a sentence for the screen. */
export function whyNotCollect(o: { sourceSystem: string | null; status: string; deletedAt?: Date | null }, dueMinor: number): string | null {
  if (o.deletedAt) return 'This order was deleted.';
  if (o.sourceSystem === 'SCALEEZY_POS') return 'This bill was made on the POS till. Take the balance on the till, so the till and Inventory both know.';
  if (o.sourceSystem === 'SHOPIFY') return 'This order was paid on Shopify.';
  if (o.status === 'CANCELLED') return 'This order was cancelled, so nothing is owed.';
  if (o.status === 'DRAFT') return 'Confirm the order before taking money for it.';
  if (dueMinor <= 0) return 'Nothing is due on this order.';
  return null;
}

export async function collectPayment(clientId: string, userId: string | null, orderId: string, body: CollectBody) {
  const onceKey = `COLLECT:${orderId}:${body.key}`;
  return runTransaction(async (tx) => {
    // The lock: a second collection waits here and then sees the first one's money.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM sales_orders WHERE id = ${orderId} AND client_id = ${clientId} FOR UPDATE`;
    if (!locked.length) throw notFound('That order was not found.');

    const already = await tx.salesOrderPayment.findUnique({ where: { onceKey }, select: { id: true } });
    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true, orderNumber: true, status: true, sourceSystem: true, deletedAt: true, locationId: true,
        total: true, roundOff: true, writtenOff: true, payments: { select: { kind: true, amount: true } }
      }
    });
    const payableMinor = toMinor(order.total) + toMinor(order.roundOff ?? 0);
    const before = paymentSummary(payableMinor, order.payments, toMinor(order.writtenOff ?? 0));
    // The same attempt again (a double tap, a retry): the first one stands.
    if (already) return { orderNumber: order.orderNumber, recorded: false, payment: before };

    const refused = whyNotCollect(order, toMinor(before.due));
    if (refused) throw conflict(refused);
    const amountMinor = toMinor(body.amount);
    const dueMinor = toMinor(before.due);
    if (amountMinor > dueMinor) throw badRequest(`That is more than the ${rupees(dueMinor)} still due.`);

    // The same checks as the counter: a reference that is safe to keep, cash received not less than the cash amount.
    const [p] = planPayments(amountMinor, [{ method: body.method, amount: body.amount, cashReceived: body.cashReceived ?? null, reference: body.reference ?? null }], 'FULL');
    await tx.salesOrderPayment.create({
      data: {
        clientId, salesOrderId: order.id, locationId: order.locationId, kind: 'PAYMENT',
        method: p.method, amount: fromMinor(p.amountMinor),
        cashReceived: p.cashReceivedMinor === null ? null : fromMinor(p.cashReceivedMinor),
        changeGiven: p.changeMinor === null ? null : fromMinor(p.changeMinor),
        reference: p.reference, receivedById: userId, receivedAt: new Date(), onceKey
      }
    });
    const after = paymentSummary(payableMinor, [...order.payments, { kind: 'PAYMENT', amount: fromMinor(p.amountMinor) }], toMinor(order.writtenOff ?? 0));
    return { orderNumber: order.orderNumber, recorded: true, payment: after };
  }, { label: `collect ${orderId}`, tooSlowMessage: 'The payment took too long to record and was not saved. Try again.' });
}
