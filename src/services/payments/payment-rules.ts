/**
 * Money taken at the counter: is what the cashier entered a payment a shop could stand behind?
 *
 * PURE. No database and no clock. Everything in whole paise, the same as pricing, so "5,000 UPI
 * plus 2,440 cash" against a 7,440 bill is compared exactly rather than to within a rounding error.
 *
 * The rules, and why:
 *
 *   ADDS UP        A completed sale is paid in full: the rows add up to the bill exactly. Less is
 *                  money still owed, which a sale that has already gone out of the door cannot
 *                  carry; more is money nobody can account for when the drawer is counted.
 *   CHANGE         Only cash has change. "Amount received" is the note handed over, the change is
 *                  worked out here, and what goes against the bill is what was kept -- so the
 *                  drawer total is the sum of the amounts, never of the notes.
 *   ONE CASH ROW   Two cash rows on one bill is the same drawer twice, and change could not be
 *                  said to belong to either.
 *   NO CARD NUMBER The reference is how a payment is found again: a UPI transaction id, the last
 *                  four digits of a card, its approval code. A full card number stored in a shop's
 *                  database is a liability the shop never agreed to take on.
 */

import { badRequest } from '../../utils/httpError';
import { toMinor } from '../pricing';

export type PaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'POINTS' | 'CREDIT';

export interface PaymentInput {
  method: PaymentMethod;
  amount: number;
  cashReceived?: number | null;
  reference?: string | null;
}

export interface PlannedPayment {
  method: PaymentMethod;
  amountMinor: number;
  cashReceivedMinor: number | null;
  changeMinor: number | null;
  reference: string | null;
}

export const MAX_PAYMENT_ROWS = 6;
const REFERENCE_MAX = 40;

const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', POINTS: 'Points', CREDIT: 'Store credit' };

const rupees = (minor: number) =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A reference, trimmed, or null -- refusing anything that could be a card number. */
function cleanReference(method: PaymentMethod, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (text.length > REFERENCE_MAX) {
    throw badRequest(`Keep the ${METHOD_LABEL[method]} reference under ${REFERENCE_MAX} characters.`);
  }
  if (!/^[A-Za-z0-9 ./@_-]+$/.test(text)) {
    throw badRequest(`A ${METHOD_LABEL[method]} reference can only have letters, digits, spaces and . / @ _ -`);
  }
  // Card numbers are 12 to 19 digits, and people type them with spaces or dashes. Card only: a UPI
  // transaction id (UTR) is itself 12 digits, and refusing it would refuse every UPI reference.
  if (method === 'CARD' && /\d{12,}/.test(text.replace(/[\s-]/g, ''))) {
    throw badRequest('Never type the card number. Use the last 4 digits or the approval code.');
  }
  return text;
}

/**
 * Check the payments for a bill of `totalMinor` and work out the change.
 *
 * `mode` FULL is a completed sale: the rows must add up to the bill exactly.
 */
export function planPayments(totalMinor: number, rows: PaymentInput[] | null | undefined, mode: 'FULL'): PlannedPayment[] {
  const input = Array.isArray(rows) ? rows : [];

  if (totalMinor <= 0) {
    // Everything in the basket was free. Recording a payment of nothing would be a row that
    // means nothing; recording one of something would be money for no goods.
    if (input.length > 0) throw badRequest('This bill is ₹0.00, so there is nothing to pay.');
    return [];
  }
  if (input.length === 0) throw badRequest(`Take the payment: ${rupees(totalMinor)} is due.`);
  if (input.length > MAX_PAYMENT_ROWS) throw badRequest(`A bill can be split ${MAX_PAYMENT_ROWS} ways at most.`);

  let cashRows = 0;
  let pointsRows = 0;
  let creditRows = 0;
  const planned = input.map((row): PlannedPayment => {
    const method = row.method;
    if (!(method in METHOD_LABEL)) throw badRequest('Choose Cash, UPI or Card.');
    const label = METHOD_LABEL[method];

    const amountMinor = toMinor(row.amount);
    if (!(amountMinor > 0)) throw badRequest(`Enter the ${label} amount.`);

    let cashReceivedMinor: number | null = null;
    let changeMinor: number | null = null;

    // Points: whether this customer holds them, and may spend that many here, is the loyalty
    // module's question, asked inside the sale's transaction. Here only the shape of the row.
    // Store credit: whether they hold that much is the store-credit module's question, asked
    // inside the sale's transaction. Here only the shape of the row.
    if (method === 'CREDIT') {
      creditRows += 1;
      if (row.cashReceived !== null && row.cashReceived !== undefined) throw badRequest('Only cash has change. Enter the store credit amount exactly.');
      return { method, amountMinor, cashReceivedMinor: null, changeMinor: null, reference: null };
    }
    if (method === 'POINTS') {
      pointsRows += 1;
      if (row.cashReceived !== null && row.cashReceived !== undefined) throw badRequest('Only cash has change. Enter the points amount exactly.');
      return { method, amountMinor, cashReceivedMinor: null, changeMinor: null, reference: null };
    }

    if (method === 'CASH') {
      cashRows += 1;
      if (row.cashReceived !== null && row.cashReceived !== undefined) {
        cashReceivedMinor = toMinor(row.cashReceived);
        if (cashReceivedMinor < amountMinor) {
          throw badRequest(`Cash received (${rupees(cashReceivedMinor)}) is less than the ${rupees(amountMinor)} to be paid in cash.`);
        }
        changeMinor = cashReceivedMinor - amountMinor;
      }
    } else if (row.cashReceived !== null && row.cashReceived !== undefined) {
      throw badRequest(`Only cash has change. Enter the ${label} amount exactly.`);
    }

    return { method, amountMinor, cashReceivedMinor, changeMinor, reference: cleanReference(method, row.reference) };
  });

  if (cashRows > 1) throw badRequest('Put all the cash in one row.');
  if (pointsRows > 1) throw badRequest('Use points once on a bill.');
  if (creditRows > 1) throw badRequest('Use store credit once on a bill.');

  const paidMinor = planned.reduce((sum, p) => sum + p.amountMinor, 0);
  if (mode === 'FULL' && paidMinor !== totalMinor) {
    throw Object.assign(
      badRequest(
        paidMinor < totalMinor
          ? `${rupees(totalMinor - paidMinor)} is still to be paid. The bill is ${rupees(totalMinor)}.`
          : `The payments come to ${rupees(paidMinor)}, more than the ${rupees(totalMinor)} bill. Give change in cash instead.`
      ),
      { details: { code: 'PAYMENT_MISMATCH', totalDue: totalMinor / 100, paid: paidMinor / 100 } }
    );
  }

  return planned;
}

/** Paid, refunded and still due, worked out from the rows -- never stored twice. */
export function paymentSummary(totalMinor: number, rows: { kind: string; amount: unknown }[]) {
  let paidMinor = 0;
  let refundedMinor = 0;
  for (const row of rows) {
    const minor = toMinor(row.amount as any);
    if (row.kind === 'REFUND') refundedMinor += minor;
    else paidMinor += minor;
  }
  const dueMinor = Math.max(0, totalMinor - paidMinor);
  const status = refundedMinor > 0 && refundedMinor >= paidMinor ? 'REFUNDED'
    : paidMinor === 0 ? (totalMinor === 0 ? 'PAID' : 'UNPAID')
    : dueMinor > 0 ? 'PART_PAID'
    : 'PAID';
  return { paid: paidMinor / 100, refunded: refundedMinor / 100, due: dueMinor / 100, status };
}
