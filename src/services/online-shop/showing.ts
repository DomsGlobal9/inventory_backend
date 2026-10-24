import { startOfLocalDay, localDayKey, localDayKeyFromParts } from '../../utils/businessDay';
import { OnlineShopRuleError } from './rules';

/**
 * WHEN SOMETHING ON THE SHOP PAGE SHOWS: banners and the announcement bar.
 *
 * The owner picks days, not moments ("from 25 Oct until 5 Nov"), in the shop's own time zone: shown from
 * the start of the first day to the end of the last. Stored as the two moments, so the shop page only
 * compares against now and never has to know about time zones.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day key, or null for "no limit". A day that does not exist (30 Feb) is refused, not moved. */
function dayOf(v: unknown, what: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  const [y, m, d] = s.split('-').map(Number);
  if (!DAY.test(s) || localDayKeyFromParts(y, m, d) !== s) throw new OnlineShopRuleError(`The ${what} date could not be read. Pick it again.`);
  return s;
}

/** "Show from" and "show until" days to the moments they mean; both optional, until never before from. */
export function windowFrom(from: unknown, until: unknown, timeZone: string): { startsAt: Date | null; endsAt: Date | null } {
  const a = dayOf(from, '"show from"');
  const b = dayOf(until, '"show until"');
  if (a && b && b < a) throw new OnlineShopRuleError('"Show until" is before "show from". Pick the dates again.');
  const startsAt = a ? startOfLocalDay(a, timeZone) : null;
  // Until the END of the last day: the start of the day after it.
  const endsAt = b ? startOfLocalDay(localDayKeyFromParts(+b.slice(0, 4), +b.slice(5, 7), +b.slice(8, 10), 1), timeZone) : null;
  return { startsAt, endsAt };
}

/** The days back, for the screen's date boxes. */
export function daysOf(startsAt: Date | null, endsAt: Date | null, timeZone: string) {
  return {
    showFrom: startsAt ? localDayKey(startsAt, timeZone) : null,
    // endsAt is the start of the day after the last one shown.
    showUntil: endsAt ? localDayKey(new Date(endsAt.getTime() - 1), timeZone) : null
  };
}

export type ShowState = 'LIVE' | 'SOON' | 'ENDED' | 'OFF' | 'NOWHERE';

/** What the owner's screen says about it: showing now, starts later, ended, switched off, or placed nowhere. */
export function stateOf(x: { active: boolean; startsAt: Date | null; endsAt: Date | null; placements?: string[] }, now = new Date()): ShowState {
  if (!x.active) return 'OFF';
  if (x.placements && x.placements.length === 0) return 'NOWHERE';
  if (x.endsAt && x.endsAt <= now) return 'ENDED';
  if (x.startsAt && x.startsAt > now) return 'SOON';
  return 'LIVE';
}

/** The same rule as a database filter: switched on and inside its dates now. */
export const showingNow = (now = new Date()) => ({
  AND: [
    { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
    { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
  ]
});
