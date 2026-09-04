/**
 * Verifies business-day boundaries.
 *
 * This is the foundation of every daily figure, so it is tested against known-correct
 * instants rather than against itself. If a boundary is an hour out, every report built on it
 * is quietly wrong and nothing else in the system will notice.
 *
 *   npx ts-node src/scripts/verify-business-day.ts
 */
import {
  localDayKey, startOfLocalDay, localDayRange, previousDayKey,
  isValidDayKey, isDayInProgress, todayKey, DEFAULT_TIMEZONE
} from '../utils/businessDay';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const IST = 'Asia/Kolkata';

console.log('\nBOUNDARIES -- India (UTC+5:30, no daylight saving)');

// 2am on the 5th in Mumbai is 20:30 UTC on the 4th. Filing that under the 4th is exactly the
// bug this exists to prevent.
const lateNightIst = new Date('2026-09-04T20:30:00Z');
check('a 2am local sale belongs to the LOCAL day, not the UTC one',
  localDayKey(lateNightIst, IST) === '2026-09-05',
  `${localDayKey(lateNightIst, IST)} (UTC day is ${lateNightIst.toISOString().slice(0, 10)})`);

// 11pm on the 4th locally is 17:30 UTC the same day -- both agree here.
const eveningIst = new Date('2026-09-04T17:30:00Z');
check('an 11pm local sale stays on that local day',
  localDayKey(eveningIst, IST) === '2026-09-04', localDayKey(eveningIst, IST));

const start = startOfLocalDay('2026-09-05', IST);
check('local midnight is 18:30 UTC the previous day',
  start.toISOString() === '2026-09-04T18:30:00.000Z', start.toISOString());

const range = localDayRange('2026-09-05', IST);
check('a day is exactly 24 hours where there is no daylight saving',
  range.end.getTime() - range.start.getTime() === 86400000,
  String((range.end.getTime() - range.start.getTime()) / 3600000) + 'h');

check('the range covers a 2am local movement',
  lateNightIst >= range.start && lateNightIst < range.end);
check('the range excludes the previous evening',
  !(eveningIst >= range.start && eveningIst < range.end));

// The end boundary must be exclusive, or a movement at exactly local midnight is counted on
// both days and the books stop balancing.
const exactlyMidnight = startOfLocalDay('2026-09-06', IST);
check('the end boundary is exclusive, so midnight is not double counted',
  !(exactlyMidnight >= range.start && exactlyMidnight < range.end));

console.log('\nBOUNDARIES -- zones that DO shift for daylight saving');

// New York moved to daylight saving on 8 March 2026. The day that contains the change is 23
// hours long; adding a flat 24 hours would swallow an hour of the next day.
const dstDay = localDayRange('2026-03-08', 'America/New_York');
const dstHours = (dstDay.end.getTime() - dstDay.start.getTime()) / 3600000;
check('the spring-forward day is 23 hours, not 24', dstHours === 23, `${dstHours}h`);

const fallBack = localDayRange('2026-11-01', 'America/New_York');
const fallHours = (fallBack.end.getTime() - fallBack.start.getTime()) / 3600000;
check('the autumn day is 25 hours, not 24', fallHours === 25, `${fallHours}h`);

check('a zone behind UTC resolves its own midnight',
  startOfLocalDay('2026-09-05', 'America/New_York').toISOString() === '2026-09-05T04:00:00.000Z',
  startOfLocalDay('2026-09-05', 'America/New_York').toISOString());

check('a zone with a 45-minute offset works (Nepal, UTC+5:45)',
  startOfLocalDay('2026-09-05', 'Asia/Kathmandu').toISOString() === '2026-09-04T18:15:00.000Z',
  startOfLocalDay('2026-09-05', 'Asia/Kathmandu').toISOString());

console.log('\nDAY ARITHMETIC');

check('the previous day is correct', previousDayKey('2026-09-05') === '2026-09-04');
check('it crosses a month boundary', previousDayKey('2026-09-01') === '2026-08-31');
check('it crosses a year boundary', previousDayKey('2026-01-01') === '2025-12-31');
check('it handles a leap day', previousDayKey('2024-03-01') === '2024-02-29', previousDayKey('2024-03-01'));

console.log('\nINPUT VALIDATION');

check('a real date is accepted', isValidDayKey('2026-09-05'));
check('the 31st of February is rejected', !isValidDayKey('2026-02-31'));
check('month 13 is rejected', !isValidDayKey('2026-13-01'));
check('a malformed string is rejected', !isValidDayKey('05-09-2026'));
check('an empty string is rejected', !isValidDayKey(''));
check('an injection attempt is rejected', !isValidDayKey("2026-09-05'; DROP TABLE--"));

console.log('\nTODAY');
const today = todayKey(IST);
check('today is a valid key', isValidDayKey(today), today);
check('today is reported as in progress', isDayInProgress(today, IST));
check('yesterday is not in progress', !isDayInProgress(previousDayKey(today), IST));
check('the default timezone is India', DEFAULT_TIMEZONE === 'Asia/Kolkata');

console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
if (failed) {
  console.log('Failed:\n' + failures.map(f => `  - ${f}`).join('\n'));
  process.exit(1);
}
