/**
 * Payments: money taken for an order, and money paid back.
 *
 * Its own module so the Billing service can take it over later without unpicking it from the
 * counter sale. The counter sale asks it two things -- are these payments right for this bill, and
 * write them -- and knows nothing about how either is done.
 */
import { fromMinor } from '../pricing';
import { PlannedPayment } from './payment-rules';

export { planPayments, paymentSummary, MAX_PAYMENT_ROWS } from './payment-rules';
export type { PaymentInput, PlannedPayment, PaymentMethod } from './payment-rules';

/** Write checked payments against an order, inside the caller's transaction. */
export async function recordPayments(
  tx: any,
  input: { clientId: string; salesOrderId: string; locationId: string; receivedById: string | null },
  planned: PlannedPayment[]
) {
  const receivedAt = new Date();
  for (const p of planned) {
    await tx.salesOrderPayment.create({
      data: {
        clientId: input.clientId,
        salesOrderId: input.salesOrderId,
        locationId: input.locationId,
        kind: 'PAYMENT',
        method: p.method,
        amount: fromMinor(p.amountMinor),
        cashReceived: p.cashReceivedMinor === null ? null : fromMinor(p.cashReceivedMinor),
        changeGiven: p.changeMinor === null ? null : fromMinor(p.changeMinor),
        reference: p.reference,
        receivedById: input.receivedById,
        receivedAt
      }
    });
  }
}
