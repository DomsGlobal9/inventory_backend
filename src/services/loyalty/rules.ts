/**
 * Loyalty points: the arithmetic, with no database and no clock, so every rule is tested exactly.
 *
 * The rules, and why:
 *
 *   EARN ON MONEY    Points are earned on what the customer paid in money -- the bill less any points
 *                    spent on it. Points bought with points would let a balance grow by itself.
 *   WHOLE POINTS     Earned points round down, per full ₹100. Nobody is owed a fraction.
 *   SPEND IN STEPS   A point is worth a fixed number of paise; a bill takes whole points only, so the
 *                    rupee amount on the bill is always points x value, to the paisa.
 *   A LIMIT PER BILL At most maxRedeemPercent of a bill, and only once the customer holds
 *                    minRedeemPoints. A shop sets these so points are a thank-you, not free goods.
 *   RETURNS MIRROR   Goods coming back undo their share: points used on them are given back as
 *                    points (never as cash), and points earned on them are taken back. Shares are
 *                    worked out cumulatively, so three returns of one bill undo exactly what one
 *                    return of everything would.
 */
import { badRequest } from '../../utils/httpError';

export interface LoyaltyRules {
  pointsPer100: number;
  pointValuePaise: number;
  minRedeemPoints: number;
  maxRedeemPercent: number;
  expiryMonths: number;
  birthdayPoints: number;
}

export const DEFAULT_RULES: LoyaltyRules = {
  pointsPer100: 1,
  pointValuePaise: 100,
  minRedeemPoints: 100,
  maxRedeemPercent: 50,
  expiryMonths: 12,
  birthdayPoints: 0
};

/** Bounds a shop can choose within, and the sentence when outside them. */
const BOUNDS: Record<keyof LoyaltyRules, [number, number, string]> = {
  pointsPer100:     [0, 100,     'Points for every ₹100 must be between 0 and 100.'],
  pointValuePaise:  [1, 100_000, 'A point must be worth between 1 paisa and ₹1,000.'],
  minRedeemPoints:  [0, 1_000_000, 'Points needed before using them must be between 0 and 10,00,000.'],
  maxRedeemPercent: [1, 100,     'The share of a bill that points can pay must be between 1% and 100%.'],
  expiryMonths:     [0, 120,     'Points can last at most 120 months (0 means they never lapse).'],
  birthdayPoints:   [0, 100_000, 'Birthday points must be between 0 and 1,00,000.']
};

export function checkRules(input: Partial<Record<keyof LoyaltyRules, unknown>>): Partial<LoyaltyRules> {
  const out: Partial<LoyaltyRules> = {};
  for (const key of Object.keys(BOUNDS) as (keyof LoyaltyRules)[]) {
    const raw = input[key];
    if (raw === undefined) continue;
    const [min, max, message] = BOUNDS[key];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) throw badRequest(message);
    out[key] = raw;
  }
  return out;
}

/** Points earned on a bill: per full ₹100 of what was paid in money. */
export function pointsEarned(moneyPaidMinor: number, rules: Pick<LoyaltyRules, 'pointsPer100'>): number {
  if (!(moneyPaidMinor > 0) || rules.pointsPer100 <= 0) return 0;
  return Math.floor(moneyPaidMinor / 10_000) * rules.pointsPer100;
}

export const rupeesOf = (minor: number) =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** What `points` are worth, in paise. */
export const valueOf = (points: number, rules: Pick<LoyaltyRules, 'pointValuePaise'>) => points * rules.pointValuePaise;

/**
 * How many points may pay part of a bill of `billMinor`, for someone holding `held`.
 * The most the screen may offer; also the check at Complete sale.
 */
export function mostUsable(held: number, billMinor: number, rules: LoyaltyRules): number {
  if (held < Math.max(1, rules.minRedeemPoints)) return 0;
  const capMinor = Math.floor((billMinor * rules.maxRedeemPercent) / 100);
  return Math.max(0, Math.min(held, Math.floor(capMinor / rules.pointValuePaise)));
}

/**
 * A points payment of `amountMinor` on a bill: the points it takes, or the sentence saying why not.
 * Checked against what the customer holds at this moment (the caller then takes them with a guarded
 * update, so two tills spending the same points at once cannot both succeed).
 */
export function pointsForPayment(amountMinor: number, billMinor: number, held: number, rules: LoyaltyRules): number {
  if (amountMinor % rules.pointValuePaise !== 0) {
    throw badRequest(`Points pay in steps of ${rupeesOf(rules.pointValuePaise)}. Change the points amount.`);
  }
  const points = amountMinor / rules.pointValuePaise;
  const minimum = Math.max(1, rules.minRedeemPoints);
  if (held < minimum) {
    throw badRequest(`Points can be used once the customer has ${minimum.toLocaleString('en-IN')}. They have ${held.toLocaleString('en-IN')}.`);
  }
  if (points > held) {
    throw badRequest(`The customer has ${held.toLocaleString('en-IN')} points, not ${points.toLocaleString('en-IN')}.`);
  }
  const most = mostUsable(held, billMinor, rules);
  if (points > most) {
    throw badRequest(`Points can pay up to ${rules.maxRedeemPercent}% of a bill: ${most.toLocaleString('en-IN')} points (${rupeesOf(valueOf(most, rules))}) here.`);
  }
  return points;
}

/**
 * The share of `whole` belonging to value returned so far, moving from `before` to `after` out of
 * `total`. Cumulative, so any number of partial returns add up to exactly the whole.
 */
export function shareBetween(whole: number, totalMinor: number, beforeMinor: number, afterMinor: number): number {
  if (!(whole > 0) || !(totalMinor > 0)) return 0;
  const clamp = (v: number) => Math.max(0, Math.min(totalMinor, v));
  const upTo = (v: number) => Math.floor((whole * clamp(v)) / totalMinor);
  return Math.max(0, upTo(afterMinor) - upTo(beforeMinor));
}

/** "MM-DD" from what a person typed or picked, or null. 29 Feb is allowed. */
export function monthDay(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw).trim();
  // "YYYY-MM-DD" from a date picker: the year is dropped on purpose.
  const m = /^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!m) throw badRequest('Give the day as month and day, for example 03-25.');
  const month = Number(m[1]), day = Number(m[2]);
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw badRequest('That day does not exist. Check the month and day.');
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The "MM-DD" days that count as today for a birthday: today, and on 28 Feb of a year that is not a
 * leap year, 29 Feb too -- so a 29 Feb birthday is still wished every year.
 */
export function birthdayKeysFor(dayKey: string): string[] {
  const [y, mo, d] = dayKey.split('-').map(Number);
  const md = `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return md === '02-28' && !leap ? [md, '02-29'] : [md];
}
