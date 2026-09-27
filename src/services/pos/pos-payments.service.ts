/**
 * Money that arrives after the sale.
 *
 * A kept order whose balance is collected a week later; a cheque or a UPI mandate that clears
 * overnight; a payment reversed because the cheque bounced. None of these are the sale, and until
 * this existed none of them reached Inventory at all -- so a shop's Day Book showed the bill and
 * never the money, and the difference only surfaced when somebody tried to reconcile a month.
 *
 * A DELTA, NEVER A RUNNING TOTAL. The event carries what was newly collected, not what the bill
 * has now been paid in total. A total cannot tell a correction from a second instalment: 2,000
 * followed by 5,000 is either "another 5,000 arrived" or "the first figure was wrong", and
 * recording the wrong reading of it either doubles the money or loses it. A delta says which,
 * in both directions -- a bounced cheque is simply a negative one.
 */
import { prisma } from '../../lib/prisma';
import { runTransaction } from '../../lib/txRetry';
import { fromMinor, toMinor } from '../pricing';
import { POS_SOURCE, type PosEventResult } from './pos-events.service';

const METHODS = ['CASH', 'UPI', 'CARD', 'POINTS', 'CREDIT'] as const;
type Method = typeof METHODS[number];

export type PosPaymentEvent = {
  invoiceNo?: string;
  /** Required. The till's own id for THIS collection, not for the bill. */
  idempotencyKey?: string;
  occurredAt?: string;
  payments?: { method?: string; amountPaise?: number; reference?: string }[];
};

/** Faults in the message, decided without touching the database. */
export function faultInPaymentShape(event: PosPaymentEvent): string | null {
  if (!event?.invoiceNo) return 'The payment update does not say which bill it is for.';
  if (!event?.idempotencyKey) {
    return 'The payment update has no idempotencyKey. A bill can legitimately collect money more ' +
           'than once, so its invoice number cannot tell a repeat from a second instalment.';
  }
  if (!Array.isArray(event.payments) || !event.payments.length) {
    return 'The payment update has no payments.';
  }
  for (const p of event.payments) {
    const m = String(p?.method ?? '').toUpperCase();
    if (!(METHODS as readonly string[]).includes(m)) {
      return `"${p?.method}" is not a way this shop can be paid. Use one of ${METHODS.join(', ')}.`;
    }
    if (!Number.isInteger(p?.amountPaise) || p!.amountPaise === 0) {
      return 'Every payment needs a whole number of paise, and zero is not a payment.';
    }
  }
  return null;
}

/**
 * Record money that arrived after the bill.
 *
 * Idempotent through the database rather than a lookup: once_key is unique, so a retry after a
 * commit whose answer was lost hits the constraint instead of taking the customer's money twice.
 */
export async function applyPaymentUpdate(
  clientId: string,
  locationId: string,
  event: PosPaymentEvent
): Promise<PosEventResult> {
  const fault = faultInPaymentShape(event);
  if (fault) return { answer: 'BAD_PAYLOAD', detail: fault };

  const invoiceNo = String(event.invoiceNo);
  const key = String(event.idempotencyKey);

  const order = await prisma.salesOrder.findFirst({
    where: { clientId, externalOrderId: invoiceNo, sourceSystem: POS_SOURCE, deletedAt: null },
    select: { id: true, orderNumber: true, total: true, locationId: true }
  });
  if (!order) {
    return { answer: 'UNKNOWN_ORDER', detail: `No sale here for invoice ${invoiceNo}.` };
  }

  const parts = event.payments!.map((p, n) => ({
    method: String(p.method).toUpperCase() as Method,
    paise: p.amountPaise as number,
    reference: typeof p.reference === 'string' ? p.reference.trim().slice(0, 100) || null : null,
    onceKey: `POS:${clientId}:${key}:${n}`
  }));

  // The same collection again: say so rather than record it twice.
  const seen = await prisma.salesOrderPayment.findFirst({
    where: { onceKey: { in: parts.map(p => p.onceKey) } },
    select: { id: true }
  });
  if (seen) {
    const bal = await outstanding(order.id, order.total);
    return {
      answer: 'ALREADY_APPLIED',
      orderNumber: order.orderNumber,
      detail: `${key} was already recorded against ${order.orderNumber}. ${owing(bal)}`
    };
  }

  const at = event.occurredAt ? new Date(event.occurredAt) : new Date();
  const receivedAt = Number.isNaN(at.getTime()) ? new Date() : at;
  const where = locationId || order.locationId;

  try {
    await runTransaction(async tx => {
      for (const p of parts) {
        /*
         * A negative delta is money going BACK -- a cheque that bounced, a UPI mandate reversed.
         * Recorded as a REFUND row of the same method rather than a negative payment, so the Day
         * Book shows it on the side it belongs on and no report has to learn that a payment can
         * be less than nothing.
         */
        await tx.salesOrderPayment.create({
          data: {
            clientId, salesOrderId: order.id, locationId: where,
            kind: p.paise < 0 ? 'REFUND' : 'PAYMENT',
            method: p.method as any,
            amount: fromMinor(Math.abs(p.paise)),
            reference: p.reference,
            onceKey: p.onceKey,
            receivedById: null,
            receivedAt
          }
        });
      }
      return parts[0].onceKey;
    }, {
      label: `pos payment ${key}`,
      tooSlowMessage: 'The shop took too long to record this payment. It has not been recorded; the till will send it again.',
      alreadyDone: async () =>
        (await prisma.salesOrderPayment.findFirst({
          where: { onceKey: parts[0].onceKey }, select: { id: true }
        }))?.id ?? null
    });
  } catch (e: any) {
    // Two copies of the same event racing: the other one won, which is the answer we wanted.
    if (String(e?.code) === 'P2002') {
      const bal = await outstanding(order.id, order.total);
      return {
        answer: 'ALREADY_APPLIED',
        orderNumber: order.orderNumber,
        detail: `${key} was already recorded against ${order.orderNumber}. ${owing(bal)}`
      };
    }
    throw e;
  }

  const bal = await outstanding(order.id, order.total);
  const took = parts.reduce((a, p) => a + p.paise, 0);
  return {
    answer: 'APPLIED',
    orderNumber: order.orderNumber,
    detail:
      `${(Math.abs(took) / 100).toFixed(2)} ${took < 0 ? 'reversed on' : 'collected against'} ` +
      `${order.orderNumber}. ${owing(bal)}`
  };
}

/** What the bill still owes, in paise. Negative means the shop owes the customer. */
async function outstanding(salesOrderId: string, total: any): Promise<number> {
  const rows = await prisma.salesOrderPayment.findMany({
    where: { salesOrderId },
    select: { kind: true, amount: true }
  });
  const paid = rows.reduce(
    (a, r) => a + (r.kind === 'REFUND' ? -toMinor(r.amount as any) : toMinor(r.amount as any)),
    0
  );
  return toMinor(total) - paid;
}

const owing = (paise: number) =>
  paise > 0 ? `${(paise / 100).toFixed(2)} still owing.`
    : paise < 0 ? `${(Math.abs(paise) / 100).toFixed(2)} overpaid.`
      : 'Paid in full.';
