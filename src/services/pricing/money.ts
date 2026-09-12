/**
 * Money, as integers.
 *
 * Every calculation in this module happens in MINOR UNITS -- paise, cents -- held in a plain
 * JavaScript number. Nothing here does arithmetic on a float rupee value, and nothing here
 * does arithmetic on a Prisma Decimal either.
 *
 * Why not floats: 0.1 + 0.2 is 0.30000000000000004. On one line nobody notices; across a
 * 40-line order and a day of trading it is how a day book stops balancing.
 *
 * Why not Decimal: it is exact, but every operation allocates, and the rounding mode has to be
 * stated at each call site -- which means it eventually is not. An integer count of paise
 * cannot be rounded by accident, because there is nothing below it to round to.
 *
 * A number can hold integers exactly up to 2^53, which is about ninety thousand billion rupees
 * in paise. The Decimal(10,2) columns these values are stored in top out eight orders of
 * magnitude sooner.
 */

import { Prisma } from '@prisma/client';

/** Anything a caller might hand us that is meant to be an amount of money. */
export type MoneyLike = Prisma.Decimal | number | string | null | undefined;

/**
 * Rupees in, paise out.
 *
 * Prisma Decimals go through `toFixed(2)`, which is exact -- Decimal.js is decimal all the way
 * down, so there is no binary representation to lose anything to. Plain numbers and strings are
 * multiplied and rounded, which is exact for any value with at most two decimal places.
 *
 * Callers are expected to have rejected anything with more than two decimal places already
 * (see `moneyInput` in the sales-order schema). This does not silently accept a third decimal
 * and quietly pick a side: it rounds, and the validator upstream is what stops that mattering.
 */
export function toMinor(value: MoneyLike): number {
  if (value === null || value === undefined) return 0;

  // Prisma.Decimal, and anything else decimal-exact that offers toFixed.
  if (typeof value === 'object' && typeof (value as any).toFixed === 'function') {
    const fixed = (value as any).toFixed(2) as string;
    const negative = fixed.startsWith('-');
    const [whole, fraction = '00'] = (negative ? fixed.slice(1) : fixed).split('.');
    const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
    return negative ? -minor : minor;
  }

  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return 0;
  return Math.round(asNumber * 100);
}

/** Paise in, a value the Decimal(10,2) columns accept out. */
export function fromMinor(minor: number): Prisma.Decimal {
  return new Prisma.Decimal(minor).dividedBy(100);
}

/** Paise in, a plain rupee number out -- for JSON responses and arithmetic outside this module. */
export function minorToNumber(minor: number): number {
  return minor / 100;
}

/**
 * A percentage of an amount, rounded HALF-UP, computed entirely in integers.
 *
 * `percent` may carry two decimal places of its own (12.5%, 33.33%); beyond that it is rounded,
 * because a discount expressed to four decimal places is a spreadsheet artefact rather than
 * something a merchant meant.
 *
 * The division is done by hand rather than with `/` and `Math.round` because the float form has
 * a real failure: `(minor * basis) / 10000` can land on 1234.4999999999998 where the exact
 * answer is 1234.5, and `Math.round` then rounds it DOWN -- silently, and only for some inputs.
 * Comparing `remainder * 2 >= divisor` in integers cannot do that.
 */
export function applyPercent(minor: number, percent: number): number {
  const basis = Math.round(percent * 100); // 20 -> 2000, 12.5 -> 1250
  const negative = minor < 0;
  const magnitude = Math.abs(minor) * basis;

  const quotient = Math.floor(magnitude / 10000);
  const remainder = magnitude - quotient * 10000;
  const rounded = remainder * 2 >= 10000 ? quotient + 1 : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Split an amount across several lines so that the parts add up to EXACTLY the whole.
 *
 * This is the largest-remainder method, and it exists because the obvious implementation is
 * wrong in a way that shows up on the very first three-line order: ₹100 across three equal
 * lines is 33.33 three times, which is ₹99.99, and one paisa has gone missing. Over a month
 * that is a day book that does not balance and nobody can say why.
 *
 * Each line gets the floor of its exact share; the paise left over are then handed out one at a
 * time, largest fractional part first. Ties go to the earlier line, so the same input always
 * produces the same output -- an order re-saved must not redistribute its own discount.
 *
 * `weights` are normally the gross line totals. When they are all zero -- a whole order of
 * zero-priced items with a discount typed against it, which should not happen but does -- the
 * amount is spread as evenly as it can be rather than thrown away.
 */
export function allocate(totalMinor: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (totalMinor === 0) return weights.map(() => 0);

  const negative = totalMinor < 0;
  const total = Math.abs(totalMinor);

  const safeWeights = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = safeWeights.reduce((a, b) => a + b, 0);

  // Nothing to weight by. Even split, remainder to the earliest lines.
  if (weightSum === 0) {
    const base = Math.floor(total / weights.length);
    const shares = weights.map(() => base);
    let left = total - base * weights.length;
    for (let i = 0; left > 0; i++, left--) shares[i] += 1;
    return negative ? shares.map(s => -s) : shares;
  }

  const exact = safeWeights.map(w => (total * w) / weightSum);
  const shares = exact.map(v => Math.floor(v));
  let remaining = total - shares.reduce((a, b) => a + b, 0);

  // Largest fractional part first; index ascending on a tie, so this is a total ordering and
  // the result is reproducible.
  const order = exact
    .map((v, index) => ({ index, fraction: v - Math.floor(v) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));

  for (let i = 0; remaining > 0; i = (i + 1) % order.length, remaining--) {
    shares[order[i].index] += 1;
  }

  return negative ? shares.map(s => -s) : shares;
}

/**
 * A net unit price to show, derived from the line total rather than kept alongside it.
 *
 * `totalPrice` is the authoritative number: it is what the customer paid for the line and what
 * a refund has to return. `unitPrice` is that divided by the quantity, which for three items
 * sharing a ₹100 discount does not divide evenly -- and multiplying the rounded unit price back
 * up would not reproduce the total.
 *
 * Both columns exist because `unitPrice` is what daybook.service and dispatch.service multiply
 * by the DISPATCHED quantity to get the revenue of a part-shipped order, and that calculation
 * needs a per-unit figure. Rounding it here, once, is better than each of them doing it.
 */
/**
 * The value of units `from`+1 through `to` of a line, out of `quantity` in total.
 *
 * For recognising revenue as goods actually leave: a line of three sold for ₹7,458.32 has no
 * exact per-unit price, so shipping all three as `unitPrice x 3` recognises ₹7,458.33 and puts a
 * paisa into the sales ledger that nobody was ever charged. Small, until it is a year of them
 * and the ledger does not reconcile with the orders it came from.
 *
 * Cumulative rather than per-instalment: each call is the difference between two running totals,
 * so however a line is split across dispatches the parts add up to the line exactly.
 */
export function portionOf(lineTotalMinor: number, quantity: number, from: number, to: number): number {
  if (quantity <= 0) return 0;
  const upTo = (n: number) => {
    const clamped = Math.max(0, Math.min(n, quantity));
    const magnitude = Math.abs(lineTotalMinor) * clamped;
    const quotient = Math.floor(magnitude / quantity);
    const remainder = magnitude - quotient * quantity;
    const rounded = remainder * 2 >= quantity ? quotient + 1 : quotient;
    return lineTotalMinor < 0 ? -rounded : rounded;
  };
  return upTo(to) - upTo(from);
}

export function netUnitPrice(lineTotalMinor: number, quantity: number): number {
  if (quantity <= 0) return 0;
  const quotient = Math.floor(lineTotalMinor / quantity);
  const remainder = lineTotalMinor - quotient * quantity;
  return remainder * 2 >= quantity ? quotient + 1 : quotient;
}
