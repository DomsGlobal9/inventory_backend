/**
 * "Weekdays, 4 to 7 pm" -- an offer that runs only at certain hours.
 *
 * Pure. Handed the moment and the shop's timezone, it says whether the offer is inside its hours.
 * The shop's timezone and not the server's: the server runs in UTC, and a Chennai shop's happy hour
 * at 4 pm is 10:30 in the morning there. Getting that wrong is an offer that runs while the shop is
 * shut and never while it is open.
 *
 * A window may cross midnight -- "10 pm to 2 am" -- in which case the DAY is the day it starts: a
 * Friday-night offer still runs at 1 am on Saturday, which is what anybody means by it.
 */

export interface OfferSchedule {
  /** 0 = Sunday ... 6 = Saturday, as JavaScript counts. Empty or missing means every day. */
  days?: number[];
  /** "HH:MM", 24-hour. */
  from: string;
  /** "HH:MM", 24-hour. Exclusive. Equal to or before `from` means the window crosses midnight. */
  to: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const minutesOf = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The weekday and minute-of-day at `now` on the shop's own clock. */
export function shopClock(now: Date, timezone: string): { day: number; minute: number } {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    // A timezone the runtime does not know must not stop the till pricing every basket. India's
    // clock is the default every shop starts with.
    format = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  const parts = format.formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return { day: WEEKDAY_INDEX[get('weekday')] ?? 0, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** What is wrong with a schedule, in words, or an empty list. */
export function validateSchedule(schedule: unknown): string[] {
  if (schedule == null) return [];
  const s = schedule as OfferSchedule;
  const problems: string[] = [];
  if (typeof s !== 'object') return ['Say which hours the offer runs.'];
  if (Number.isNaN(minutesOf(String(s.from))) || Number.isNaN(minutesOf(String(s.to)))) {
    problems.push('Give the hours as a start and end time, like 16:00 and 19:00.');
  } else if (minutesOf(s.from) === minutesOf(s.to)) {
    problems.push('The hours start and end at the same time. For all day, leave the hours off.');
  }
  if (s.days != null) {
    if (!Array.isArray(s.days) || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
      problems.push('Choose the days of the week it runs.');
    } else if (s.days.length === 0) {
      problems.push('Choose at least one day, or leave the days off for every day.');
    }
  }
  return problems;
}

/**
 * One stored copy: days sorted and unique, and every day written as no days at all -- so "all seven
 * ticked" and "never chose days" are the same offer in its history. An explicit empty list is left
 * alone for validateSchedule to refuse: that is somebody who unticked everything.
 */
export function normaliseSchedule(schedule: OfferSchedule | null | undefined): OfferSchedule | null {
  if (!schedule) return null;
  if (schedule.days == null) return { from: schedule.from, to: schedule.to };
  const days = [...new Set(schedule.days)].sort((a, b) => a - b);
  return days.length === 7 ? { from: schedule.from, to: schedule.to } : { days, from: schedule.from, to: schedule.to };
}

/** Is the offer inside its hours at `now`? No schedule means always. */
export function withinSchedule(schedule: OfferSchedule | null | undefined, now: Date, timezone: string): boolean {
  if (!schedule) return true;
  const from = minutesOf(schedule.from);
  const to = minutesOf(schedule.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;

  const { day, minute } = shopClock(now, timezone);
  const days = schedule.days?.length ? schedule.days : null;
  const runsOn = (d: number) => !days || days.includes(d);

  if (from < to) return runsOn(day) && minute >= from && minute < to;

  // Crosses midnight: the evening part belongs to today, the small hours to yesterday.
  if (minute >= from) return runsOn(day);
  if (minute < to) return runsOn((day + 6) % 7);
  return false;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon–Fri, 4 pm–7 pm" -- for history and summaries. */
export function describeSchedule(schedule: OfferSchedule | null | undefined): string | null {
  if (!schedule) return null;
  const time = (hhmm: string) => {
    const mins = minutesOf(hhmm);
    const h = Math.floor(mins / 60), m = mins % 60;
    const suffix = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
  };
  const days = schedule.days?.length ? [...schedule.days].sort((a, b) => a - b) : [];
  let dayText = 'every day';
  if (days.join() === '1,2,3,4,5') dayText = 'Mon–Fri';
  else if (days.join() === '0,6') dayText = 'weekends';
  else if (days.length) dayText = days.map(d => DAY_NAMES[d]).join(', ');
  return `${dayText}, ${time(schedule.from)}–${time(schedule.to)}`;
}
