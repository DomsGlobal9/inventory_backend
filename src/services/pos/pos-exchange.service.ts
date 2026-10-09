/**
 * A saree handed back and another carried out, in one act.
 *
 * ONE TRANSACTION, and that is the whole reason this is not two events. Recorded as a return and
 * a sale that can half-fail, a crash in between leaves the shop either short of stock it has or
 * holding stock it gave away -- and the customer has already left with the difference either way.
 *
 * HOW THE MONEY READS, which is the part that took a decision rather than code. The credit note
 * for what came back pays for what went out. That is not takings: writing it as cash would put
 * money in the owner's Day Book that never existed and cannot be found in the bank, and an owner
 * reconciling "cash sales" against a drawer would be hunting notes that were never there. But it
 * cannot be left out either, or the new bill looks unpaid and the shop chases a customer who owes
 * nothing.
 *
 * So the settled part is a payment row that names the return it was settled against
 * (settlesReturnId), and every figure that means MONEY excludes those rows: the Day Book, the
 * store-credit payout, and the store-credit share of a later refund. Only the genuine difference
 * -- what the customer actually paid or was actually given back -- is money.
 *
 * NOT store credit, deliberately, though Inventory's own counter does it that way. Store credit
 * belongs to a phone number, and a walk-in swapping a saree for a different size has not given
 * one. That is the commonest exchange in a saree shop and refusing it was not acceptable.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { runTransaction } from '../../lib/txRetry';
import { fromMinor, toMinor } from '../pricing';
import { returnService } from '../return.service';
import { writeRefund, creditShare, type RefundMethod } from '../counter-return/counter-return.service';
import {
  POS_SOURCE, writeSaleInTransaction, dateFromTill, type PosEventResult, type PosLine, type PosSaleEvent
} from './pos-events.service';
import { planReturnLines } from './pos-returns.service';

const METHODS: RefundMethod[] = ['CASH', 'UPI', 'CARD', 'CREDIT'];

export type PosExchangeEvent = {
  /** The till's own number for the whole exchange. Idempotency hangs off this. */
  exchangeNo?: string;
  againstInvoiceNo?: string;
  returned?: PosLine[];
  sold?: PosLine[];
  /** New money the customer handed over, when the new goods cost more. POINTS / CREDIT rows carry their hold (contract §10). */
  payments?: { method?: string; amountPaise?: number; holdId?: string | null }[];
  /** How the leftover went back, when the new goods cost less. */
  refund?: { method?: string; reference?: string } | null;
  refunds?: { method?: string; amountPaise?: number; reference?: string }[] | null;
  customer?: { phone?: string; name?: string } | null;
  occurredAt?: string;
  note?: string;
};

/** Faults in the message itself, decided without touching the database. */
export function faultInExchangeShape(event: PosExchangeEvent): string | null {
  if (!event?.exchangeNo) return 'The exchange has no exchange number.';
  if (!event?.againstInvoiceNo) return 'The exchange does not say which bill it is against.';
  if (!Array.isArray(event.returned) || !event.returned.length) {
    return 'The exchange has nothing coming back. A sale with nothing returned is a sale.';
  }
  if (!Array.isArray(event.sold) || !event.sold.length) {
    return 'The exchange has nothing going out. A return with nothing sold is a return.';
  }
  for (const l of [...event.returned, ...event.sold]) {
    if (!Number.isInteger(l?.qty) || l.qty <= 0) {
      return 'Every line needs a whole number of pieces above zero.';
    }
    if (!Number.isInteger(l?.lineTotalPaise) || l.lineTotalPaise < 0) {
      return 'Every line needs a whole number of paise, zero or more.';
    }
  }
  return null;
}

const keyFor = (clientId: string, exchangeNo: string) => `POS:${clientId}:${exchangeNo}`;

export async function applyExchange(
  clientId: string,
  locationId: string,
  event: PosExchangeEvent
): Promise<PosEventResult> {
  const fault = faultInExchangeShape(event);
  if (fault) return { answer: 'BAD_PAYLOAD', detail: fault };

  const exchangeNo = String(event.exchangeNo);
  const againstInvoiceNo = String(event.againstInvoiceNo);
  const key = keyFor(clientId, exchangeNo);

  // The same exchange again: what the first attempt made, not a second one.
  const already = await prisma.salesOrder.findFirst({
    where: { clientId, externalOrderId: exchangeNo, sourceSystem: POS_SOURCE },
    select: { orderNumber: true }
  });
  if (already) {
    return {
      answer: 'ALREADY_APPLIED',
      orderNumber: already.orderNumber,
      detail: `Exchange ${exchangeNo} was already recorded as ${already.orderNumber}.`
    };
  }

  // What comes back, and which dispatch row each piece belongs to. Same planner a return uses.
  const planned = await planReturnLines(clientId, againstInvoiceNo, event.returned!, exchangeNo);
  if (!planned.ok) return planned.result;
  const { order, taking } = planned;

  // What goes out has to be in this shop's catalogue before anything is written.
  const wanted = [...new Set(event.sold!.map(l => l.itemCode))];
  const variants = await prisma.productVariant.findMany({
    where: { clientId, OR: [{ variantCode: { in: wanted } }, { sku: { in: wanted } }] },
    select: { id: true, variantCode: true, sku: true }
  });
  const byCode = new Map<string, string>();
  for (const v of variants) {
    byCode.set(v.variantCode, v.id);
    if (!byCode.has(v.sku)) byCode.set(v.sku, v.id);
  }
  const missing = wanted.filter(c => !byCode.has(c));
  if (missing.length) {
    return { answer: 'UNKNOWN_ITEM', detail: `Not in this shop's catalogue: ${missing.join(', ')}.` };
  }

  const soldMinor = event.sold!.reduce((a, l) => a + l.lineTotalPaise, 0);
  const where = locationId || order.locationId;
  const warnings: string[] = [];

  const saleEvent: PosSaleEvent = {
    kind: 'sale.completed',
    invoiceNo: exchangeNo,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    lines: event.sold!,
    totals: {},
    // Only the genuine difference. The settled part is written separately, as a settlement.
    payments: (event.payments ?? []).map(p => ({
      method: String(p.method ?? 'CASH').toUpperCase(),
      amountPaise: Number(p.amountPaise ?? 0),
      // Points or credit on the new bill settle exactly as on a sale: through the hold.
      holdId: p.holdId ?? null
    })) as any,
    customer: event.customer ?? undefined
  } as any;

  const made = await runTransaction(async tx => {
    // ── what came back ──────────────────────────────────────────────────────────────────
    const created = await returnService.createReturnIn(
      tx, clientId, order.id, taking,
      event.note ? String(event.note).slice(0, 500) : `POS exchange ${exchangeNo}`,
      'OTHER'
    );
    for (const item of created.items) {
      await tx.salesReturnItem.update({ where: { id: item.id }, data: { disposition: 'RESTOCK' } });
    }
    await tx.salesReturn.update({
      where: { id: created.id },
      data: { status: 'INSPECTED', atCounter: true, counterKey: key, locationId: where }
    });
    await returnService.completeReturnIn(tx, clientId, created.id, { restockAt: where });

    const done = await tx.salesReturn.findUniqueOrThrow({
      where: { id: created.id },
      select: { refundTotal: true, returnNumber: true }
    });
    const backMinor = toMinor(done.refundTotal as any);

    /*
     * How much of what came back pays for what went out.
     *
     * Never more than the new goods are worth: swap a 3,000 saree for a 2,000 one and only 2,000
     * is settled, the other 1,000 is real money going back to the customer.
     */
    const settledMinor = Math.min(backMinor, soldMinor);
    const leftoverMinor = backMinor - settledMinor;

    if (settledMinor > 0) {
      // On the OLD bill: the credit note is satisfied by goods, not by money.
      await tx.salesOrderPayment.create({
        data: {
          clientId, salesOrderId: order.id, locationId: where,
          kind: 'REFUND', method: 'CREDIT', amount: fromMinor(settledMinor),
          salesReturnId: created.id, settlesReturnId: created.id,
          receivedById: null
        }
      });
    }

    if (leftoverMinor > 0) {
      // Real money going back, by whatever way the till gave it.
      const wantedMethod = String(event.refund?.method ?? 'CASH').toUpperCase();
      const method: RefundMethod =
        (METHODS as string[]).includes(wantedMethod) ? wantedMethod as RefundMethod : 'CASH';
      const reference = typeof event.refund?.reference === 'string'
        ? event.refund.reference.trim().slice(0, 100) || null
        : null;
      const creditBackMinor = await creditShare(tx, clientId, order.id, leftoverMinor, created.id);
      await writeRefund(tx, {
        clientId, orderId: order.id, returnId: created.id, returnNumber: done.returnNumber,
        locationId: where, customerId: order.customerId ?? null,
        moneyMinor: leftoverMinor, creditBackMinor, method, reference, userId: null
      });
    }

    await tx.salesReturn.update({
      where: { id: created.id },
      data: { refundStatus: 'REFUNDED', refundedAt: new Date() }
    });

    // ── what went out ───────────────────────────────────────────────────────────────────
    const newOrder: any = await writeSaleInTransaction(tx, clientId, where, saleEvent, byCode);

    if (settledMinor > 0) {
      // On the NEW bill: paid for with the returned goods. Makes the bill paid without
      // pretending money arrived.
      await tx.salesOrderPayment.create({
        data: {
          clientId, salesOrderId: newOrder.id, locationId: where,
          kind: 'PAYMENT', method: 'CREDIT', amount: fromMinor(settledMinor),
          settlesReturnId: created.id,
          receivedById: null
        }
      });
    }

    // The swap happened when the till says, for both halves (the new bill's own rows included).
    await dateFromTill(tx, event.occurredAt, { orderId: newOrder.id, returnId: created.id });
    return { orderNumber: newOrder.orderNumber, returnNumber: done.returnNumber, settledMinor, leftoverMinor, backMinor };
  }, {
    label: `pos exchange ${exchangeNo}`,
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    tooSlowMessage: 'The shop took too long to record this exchange. Nothing was recorded; the till will send it again.',
    alreadyDone: async () => {
      const o = await prisma.salesOrder.findFirst({
        where: { clientId, externalOrderId: exchangeNo, sourceSystem: POS_SOURCE },
        select: { orderNumber: true }
      });
      const r = await prisma.salesReturn.findUnique({
        where: { counterKey: key }, select: { returnNumber: true }
      });
      return o ? { orderNumber: o.orderNumber, returnNumber: r?.returnNumber ?? '', settledMinor: 0, leftoverMinor: 0, backMinor: 0 } : null;
    }
  });

  const difference = soldMinor - made.backMinor;
  /*
   * What the till took for the new goods should be exactly the difference. Short, and the new bill
   * shows money still due; over, and it shows money overpaid -- both silently, unless said here.
   * Recorded as the till sent it either way: the customer has already left.
   */
  if (difference > 0) {
    const took = (event.payments ?? []).reduce((a, p) => a + Math.round(Number(p.amountPaise ?? 0)), 0);
    if (took !== difference) {
      warnings.push(
        `${exchangeNo}: the till took ${(took / 100).toFixed(2)} for the new goods, but after what came back ` +
        `the customer owed ${(difference / 100).toFixed(2)}. ${made.orderNumber} now shows ` +
        `${(Math.abs(difference - took) / 100).toFixed(2)} ${took < difference ? 'still due' : 'overpaid'} -- somebody should settle it.`
      );
    }
  }
  return {
    answer: 'APPLIED',
    orderNumber: made.orderNumber,
    ...(warnings.length ? { warnings } : {}),
    detail:
      `${exchangeNo}: ${made.returnNumber} back against ${order.orderNumber}, ` +
      `${made.orderNumber} out. ` +
      (difference > 0 ? `${(difference / 100).toFixed(2)} paid by the customer.`
        : difference < 0 ? `${(Math.abs(difference) / 100).toFixed(2)} given back.`
          : 'An even swap: no money moved.')
  };
}
