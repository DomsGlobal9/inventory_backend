/**
 * Verifies what a snapshot now means: the CLOSING state of a business day that has finished.
 *
 * The property that matters is that the figure does not depend on when the job ran. The old
 * engine read live stock on an hourly tick and filed it under today's date, so the row was a
 * partial day while the day was still going, and a finished day only held its true closing if
 * a tick happened to land in the last minutes before midnight. On a host that sleeps it did
 * not, and since the day book reads the previous day's snapshot as today's opening balance,
 * that error became a wrong opening and the books stopped balancing.
 *
 *   npx ts-node src/scripts/verify-snapshot.ts
 */
import { prisma } from '../lib/prisma';
import { SnapshotService } from '../services/snapshot.service';
import { startOfLocalDay, todayKey, previousDayKey, localDayKey } from '../utils/businessDay';

const TENANT_EMAIL = 'e2e1788452461634@example.com';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

async function main() {
  const owner = await prisma.user.findFirst({
    where: { email: TENANT_EMAIL }, select: { clientId: true }
  });
  if (!owner) throw new Error('Test tenant not found');
  const clientId = owner.clientId;

  const service = new SnapshotService();
  const tz = await service.getTimezone(clientId);
  const today = todayKey(tz);
  const yesterday = previousDayKey(today);

  console.log(`\ntenant timezone ${tz}; today is ${today} on their clock\n`);

  // --- TODAY IS NOT SNAPSHOTTED ---------------------------------------------
  console.log('A DAY IN PROGRESS IS NOT RECORDED');

  const todayRow = await prisma.dailyInventorySnapshot.findFirst({
    where: { clientId, snapshotDate: startOfLocalDay(today, tz) }
  });
  check('no snapshot exists for the day still in progress',
    todayRow === null, todayRow ? `found ${todayRow.totalUnits} units` : '');

  let refused = false;
  try { await service.snapshotDay(clientId, today); }
  catch { refused = true; }
  check('asking for today\'s snapshot is refused rather than writing a partial day', refused);

  let refusedFuture = false;
  try { await service.snapshotDay(clientId, '2099-01-01'); }
  catch { refusedFuture = true; }
  check('a future day is refused too', refusedFuture);

  // --- THE CLOSING FIGURE IS THE LEDGER'S, NOT THE CLOCK'S -------------------
  console.log('\nCLOSING IS DERIVED, NOT MEASURED WHEN THE JOB HAPPENS TO RUN');

  const liveUnits = (await prisma.inventoryStock.aggregate({
    where: { clientId }, _sum: { quantity: true }
  }))._sum.quantity || 0;

  const dayEnd = startOfLocalDay(today, tz); // end of yesterday == start of today
  const movedSince = Number((await prisma.inventoryTransaction.aggregate({
    where: { clientId, createdAt: { gte: dayEnd } }, _sum: { quantity: true }
  }))._sum.quantity || 0);

  const closing = await service.closingForDay(clientId, yesterday);
  check('yesterday\'s closing equals live stock minus everything that moved since',
    closing.units === liveUnits - movedSince,
    `${closing.units} vs ${liveUnits} - ${movedSince} = ${liveUnits - movedSince}`);

  // Computing it twice must agree; it is a function of the ledger, not of the wall clock.
  const closingAgain = await service.closingForDay(clientId, yesterday);
  check('computing the same day twice gives the same answer',
    closing.units === closingAgain.units, `${closing.units} vs ${closingAgain.units}`);

  const storedYesterday = await prisma.dailyInventorySnapshot.findFirst({
    where: { clientId, snapshotDate: startOfLocalDay(yesterday, tz) },
    select: { totalUnits: true }
  });
  check('the stored row for yesterday matches what the ledger says it should be',
    storedYesterday !== null && storedYesterday.totalUnits === closing.units,
    `stored ${storedYesterday?.totalUnits} vs derived ${closing.units}`);

  // --- PER LOCATION ---------------------------------------------------------
  console.log('\nPER LOCATION');

  const locSum = [...closing.byLocation.values()].reduce((a, l) => a + l.units, 0);
  check('the locations add up to the company-wide figure',
    locSum === closing.units, `${locSum} vs ${closing.units}`);

  const locations = await prisma.stockLocation.findMany({
    where: { clientId }, select: { id: true }
  });
  check('every location gets a row, including any that emptied out',
    locations.every(l => closing.byLocation.has(l.id)),
    `${closing.byLocation.size} rows for ${locations.length} locations`);

  const storedLoc = await prisma.dailyLocationSnapshot.findMany({
    where: { clientId, snapshotDate: startOfLocalDay(yesterday, tz) },
    select: { locationId: true, totalUnits: true }
  });
  check('the stored per-location rows match the derived ones',
    storedLoc.length > 0 && storedLoc.every(r =>
      closing.byLocation.get(r.locationId)?.units === r.totalUnits),
    JSON.stringify(storedLoc.map(r => ({
      stored: r.totalUnits, derived: closing.byLocation.get(r.locationId)?.units
    }))));

  // --- DATES SIT ON THE SHOP'S MIDNIGHT -------------------------------------
  console.log('\nDATED BY THE SHOP\'S CALENDAR');

  const rows = await prisma.dailyInventorySnapshot.findMany({
    where: { clientId }, select: { snapshotDate: true }, orderBy: { snapshotDate: 'desc' }, take: 10
  });
  const offMidnight = rows.filter(r =>
    startOfLocalDay(localDayKey(r.snapshotDate, tz), tz).getTime() !== r.snapshotDate.getTime());
  check('every row sits exactly on the shop\'s midnight, not UTC midnight',
    offMidnight.length === 0, `${offMidnight.length} of ${rows.length} are off`);

  check('no row is dated in the future',
    rows.every(r => localDayKey(r.snapshotDate, tz) < today),
    JSON.stringify(rows.slice(0, 3).map(r => localDayKey(r.snapshotDate, tz))));

  // --- CATCHING UP IS SAFE TO REPEAT ----------------------------------------
  console.log('\nCATCHING UP IS IDEMPOTENT');

  const before = await prisma.dailyInventorySnapshot.count({ where: { clientId } });
  const first = await service.catchUpTenant(clientId);
  const mid = await prisma.dailyInventorySnapshot.count({ where: { clientId } });
  const second = await service.catchUpTenant(clientId);
  const after = await prisma.dailyInventorySnapshot.count({ where: { clientId } });

  check('a catch-up with nothing missing writes nothing',
    second.written.length === 0, JSON.stringify(second.written));
  check('running it twice does not duplicate rows',
    mid === after, `${before} -> ${mid} -> ${after}`);
  check('it never reaches into the day in progress',
    !first.written.includes(today) && !second.written.includes(today));

  // --- THE DAY BOOK LEANS ON IT ---------------------------------------------
  console.log('\nTHE DAY BOOK READS IT AS TODAY\'S OPENING');

  const { DayBookService } = await import('../services/daybook.service');
  const daybook = new DayBookService();
  const day = await daybook.getDay(clientId, today);

  check('today is reported as still running', day.inProgress === true);
  check('today\'s opening is yesterday\'s stored closing',
    day.opening.units === storedYesterday?.totalUnits,
    `opening ${day.opening.units} vs stored ${storedYesterday?.totalUnits}`);
  check('today\'s opening came from a snapshot, not a fallback derivation',
    day.opening.source === 'snapshot', String(day.opening.source));
  const dayClosing = day.closing;
  check('the day book states a closing figure for today at all', dayClosing !== null);
  check('opening + in - out still equals closing',
    dayClosing !== null &&
      day.opening.units + day.stockIn.totalUnits - day.stockOut.totalUnits === dayClosing.units,
    `${day.opening.units} + ${day.stockIn.totalUnits} - ${day.stockOut.totalUnits} != ${dayClosing?.units}`);
  check('today\'s closing equals the stock actually on the shelves',
    dayClosing?.units === liveUnits, `${dayClosing?.units} vs ${liveUnits}`);

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
