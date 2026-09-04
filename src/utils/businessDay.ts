/**
 * Business-day boundaries in a shop's own timezone.
 *
 * Everything in this system is stored in UTC, which is correct for storage and wrong for a
 * day book. India runs 5.5 hours ahead, so a sale rung up at 2am on the 5th is 20:30 UTC on
 * the 4th -- and a "daily report" built on UTC days would file it under the wrong date. The
 * owner's numbers would not match their till, which is the fastest way to make a report
 * worthless.
 *
 * These helpers convert between the two. Built on Intl, which ships with Node and knows the
 * real IANA rules including daylight saving, rather than a hardcoded offset that would be
 * wrong for half the year in most of the world.
 */

/** Default for this product's market. Overridable per shop -- see ClientSettings.timezone. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * How far ahead of UTC the zone is at that instant, in milliseconds.
 *
 * Derived by asking Intl what wall-clock time the instant shows in the zone and comparing it
 * with the same fields read as UTC. Doing it per-instant rather than per-zone is what makes
 * daylight saving correct: the same zone has different offsets in June and December.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find(p => p.type === type)?.value);

  const wallClockAsUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    // Intl can emit hour 24 for midnight under hour12:false in some environments.
    field('hour') % 24,
    field('minute'),
    field('second')
  );

  // Milliseconds are dropped by the formatter, so compare on whole seconds.
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The calendar date showing in that zone, as "YYYY-MM-DD". */
export function localDayKey(instant: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  // en-CA formats as YYYY-MM-DD, which sorts correctly as text.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(instant);
}

/**
 * The UTC instant at which a local calendar day begins.
 *
 * Resolved in two passes. The first guess uses the offset at UTC midnight, which is wrong
 * whenever a daylight-saving change falls between that moment and local midnight; the second
 * pass re-reads the offset at the corrected instant and settles it. India never shifts, but
 * this is a shared helper and a report that silently loses an hour twice a year is exactly
 * the kind of fault nobody finds until the numbers are already wrong.
 */
export function startOfLocalDay(dayKey: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  const [year, month, day] = dayKey.split('-').map(Number);

  const naiveUtcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let instant = new Date(naiveUtcMidnight - zoneOffsetMs(new Date(naiveUtcMidnight), timeZone));
  instant = new Date(naiveUtcMidnight - zoneOffsetMs(instant, timeZone));

  return instant;
}

/**
 * Start (inclusive) and end (exclusive) of a local day, as UTC instants.
 *
 * End is computed from the NEXT day's start rather than by adding 24 hours, because a
 * daylight-saving day is 23 or 25 hours long. Adding a fixed day would either miss an hour of
 * movements or count an hour twice.
 */
export function localDayRange(dayKey: string, timeZone: string = DEFAULT_TIMEZONE): { start: Date; end: Date } {
  const start = startOfLocalDay(dayKey, timeZone);

  const [year, month, day] = dayKey.split('-').map(Number);
  const nextKey = localDayKeyFromParts(year, month, day, 1);

  return { start, end: startOfLocalDay(nextKey, timeZone) };
}

/** Shifts a calendar date by whole days without timezone involvement. */
export function localDayKeyFromParts(year: number, month: number, day: number, addDays = 0): string {
  const d = new Date(Date.UTC(year, month - 1, day + addDays));
  return d.toISOString().slice(0, 10);
}

/** The day before a given key, e.g. for an opening balance. */
export function previousDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return localDayKeyFromParts(y, m, d, -1);
}

/** Today's date in the shop's zone. */
export function todayKey(timeZone: string = DEFAULT_TIMEZONE): string {
  return localDayKey(new Date(), timeZone);
}

/**
 * Whether the day is still in progress, so a report can say "so far today" rather than
 * presenting a partial day as a closed one.
 */
export function isDayInProgress(dayKey: string, timeZone: string = DEFAULT_TIMEZONE): boolean {
  return dayKey === todayKey(timeZone);
}

/** Rejects anything that is not a real calendar date before it reaches a query. */
export function isValidDayKey(dayKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return false;
  const [y, m, d] = dayKey.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}
