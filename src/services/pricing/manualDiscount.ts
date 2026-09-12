/**
 * A person taking money off at the counter.
 *
 * Every real shop does this. A saree with a mark on it, a customer who has bought here for
 * fifteen years, a manager settling an argument -- none of it fits an offer, and a system that
 * refuses to allow it is a system the shop works around by editing the price of the product.
 * That is far worse: the catalogue is then wrong for everybody, and there is no record that
 * anything was decided.
 *
 * So it is allowed, and made accountable instead:
 *
 *   PERMISSION   offer:manual_discount, checked at the route. A cashier does not get it by
 *                default; a manager does.
 *   REASON       required, and kept. It is the whole audit trail -- "200 off" six months later
 *                with no reason beside it is indistinguishable from theft.
 *   RECORDED     as a SalesOrderDiscount with source MANUAL, next to the offers, so one query
 *                answers "what came off this order and who decided".
 *
 * PURE. No database, no permissions, no clock. Just: is this a discount a shop could defend?
 */

import { badRequest } from '../../utils/httpError';
import { toMinor } from './money';

export interface ManualDiscountInput {
  amount?: number | null;
  reason?: string | null;
}

export interface ManualDiscount {
  amountMinor: number;
  reason: string;
}

export const REASON_MIN_LENGTH = 4;
export const REASON_MAX_LENGTH = 200;

/*
 * Reasons that are not reasons.
 *
 * Requiring a reason and then accepting "x" gets a field full of "x", which is worse than no
 * field at all: it looks like an audit trail and answers nothing. These are the strings people
 * actually type when they want a required box to go away, collected from the same problem in
 * the stock-adjustment reason field.
 *
 * Matched on the WHOLE trimmed string, never as a substring -- "test fit issue, customer
 * returning" is a real reason that happens to start with "test".
 */
const EMPTY_REASONS = new Set([
  'na', 'n/a', 'nil', 'none', 'no', 'nothing', 'nothin',
  'test', 'testing', 'asdf', 'asd', 'qwerty', 'abc', 'xxx',
  'discount', 'disc', 'offer', 'manual', 'manual discount',
  'ok', 'okay', 'yes', 'done', 'good', 'fine', '...', '--'
]);

/**
 * Check one manual discount and normalise it, or say exactly what is wrong with it.
 *
 * Returns null when the caller asked for nothing at all -- no amount and no reason. That is the
 * ordinary case (most orders carry no manual discount) and must not be an error.
 *
 * `label` is what the message calls the thing: "this order", or a SKU.
 */
export function normaliseManualDiscount(
  input: ManualDiscountInput | null | undefined,
  label: string
): ManualDiscount | null {
  if (input == null) return null;

  const rawAmount = input.amount;
  const rawReason = typeof input.reason === 'string' ? input.reason.trim() : '';

  // Nothing asked for. Not an error, and not a discount either.
  if ((rawAmount == null || Number(rawAmount) === 0) && !rawReason) return null;

  if (rawAmount == null || !Number.isFinite(Number(rawAmount))) {
    throw badRequest(`Say how much to take off ${label}.`);
  }

  const amount = Number(rawAmount);
  if (amount <= 0) {
    // Zero with a reason attached is somebody who meant to type an amount and did not.
    throw badRequest(`A discount on ${label} has to be more than nothing.`);
  }
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw badRequest(`A discount on ${label} cannot have more than two decimal places.`);
  }

  if (!rawReason) {
    throw badRequest(
      `Say why money is coming off ${label}. It is kept on the order, and it is the only ` +
      `record of who decided.`
    );
  }
  if (rawReason.length < REASON_MIN_LENGTH || EMPTY_REASONS.has(rawReason.toLowerCase())) {
    throw badRequest(
      `"${rawReason}" does not say why money is coming off ${label}. Write what actually ` +
      `happened -- a damaged piece, a price match, a manager's decision.`
    );
  }
  if (rawReason.length > REASON_MAX_LENGTH) {
    throw badRequest(`Keep the reason for ${label} under ${REASON_MAX_LENGTH} characters.`);
  }

  return { amountMinor: toMinor(amount), reason: rawReason };
}

/**
 * True when a request asks for any manual discount anywhere in it.
 *
 * The route needs this BEFORE it validates anything, because the permission check has to be
 * conditional: an ordinary order must not require `offer:manual_discount`, and an order that
 * takes money off by hand must not be able to avoid it by being malformed.
 *
 * Deliberately loose -- it asks "did the caller mention this at all", not "is it valid". A
 * cashier without the permission who sends a broken manual discount should be told they are not
 * allowed to do it, not handed a validation message that teaches them the right shape.
 */
export function requestsManualDiscount(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (data.manualDiscount != null) return true;
  if (Array.isArray(data.items)) {
    return data.items.some((i: any) => i && i.manualDiscount != null);
  }
  return false;
}
