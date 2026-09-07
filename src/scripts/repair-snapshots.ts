/**
 * Brings the snapshot table in line with what a snapshot now means.
 *
 * Under the old scheme the hourly job wrote a row dated TODAY holding whatever stock happened
 * to be on the shelves at that moment, and rewrote it each hour. Two things are wrong with
 * that, and both matter:
 *
 *   - A row dated today is a partial day filed under a label that reads as final. Anyone
 *     reading it mid-afternoon gets a number that will still change.
 *   - The row for a finished day only held that day's true closing if the job happened to
 *     fire in the last minutes before midnight. On a host that sleeps when idle it usually
 *     did not, so the row was short by everything that moved after the last tick -- and the
 *     day book takes the previous day's snapshot as today's OPENING balance, so that error
 *     became a wrong opening and the books stopped balancing.
 *
 * This deletes every row dated today or later, then recomputes recent finished days from the
 * ledger, which is exact regardless of when it runs.
 *
 *   npx ts-node src/scripts/repair-snapshots.ts           # report only
 *   npx ts-node src/scripts/repair-snapshots.ts --apply
 */
import { prisma } from '../lib/prisma';
import { SnapshotService } from '../services/snapshot.service';
import { localDayKey, startOfLocalDay, todayKey, previousDayKey } from '../utils/businessDay';

/**
 * How far back to recompute. Only the days the hourly job actually wrote are suspect; older
 * rows came from a full ledger replay and are already exact, so reaching further back would
 * cost round trips to rewrite correct rows with the same numbers.
 */
const RECOMPUTE_DAYS = 4;

async function main() {
  const apply = process.argv.includes('--apply');
  const service = new SnapshotService();
  const tenants = await service.getActiveTenants();

  let partialRows = 0;
  let locationPartialRows = 0;
  const plan: { clientId: string; days: string[] }[] = [];

  for (const clientId of tenants) {
    const tz = await service.getTimezone(clientId);
    const today = todayKey(tz);
    const todayStart = startOfLocalDay(today, tz);

    partialRows += await prisma.dailyInventorySnapshot.count({
      where: { clientId, snapshotDate: { gte: todayStart } }
    });
    locationPartialRows += await prisma.dailyLocationSnapshot.count({
      where: { clientId, snapshotDate: { gte: todayStart } }
    });

    // Which finished days are worth recomputing: the recent ones, back to the tenant's first
    // movement, since anything before that has no stock to state.
    const first = await prisma.inventoryTransaction.findFirst({
      where: { clientId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true }
    });
    if (!first) { plan.push({ clientId, days: [] }); continue; }

    const firstDay = localDayKey(first.createdAt, tz);
    const days: string[] = [];
    let cursor = previousDayKey(today);
    while (days.length < RECOMPUTE_DAYS && cursor >= firstDay) {
      days.unshift(cursor);
      cursor = previousDayKey(cursor);
    }

    // A tenant whose stock has not moved in the window needs nothing: with no movements
    // after those days ended, today's stock IS each of their closing figures, which is what
    // the old job happened to record. Skipping them is not a shortcut -- recomputing would
    // write back the identical numbers, at several round trips a day.
    if (days.length) {
      const windowStart = startOfLocalDay(days[0], tz);
      const moved = await prisma.inventoryTransaction.count({
        where: { clientId, createdAt: { gte: windowStart } }
      });
      if (moved === 0) { plan.push({ clientId, days: [] }); continue; }
    }

    plan.push({ clientId, days });
  }

  console.log(`partial rows dated today or later: ${partialRows} company-wide, ${locationPartialRows} per-location`);
  console.log(`tenants to recompute:              ${plan.filter(p => p.days.length).length} of ${tenants.length}`);
  console.log(`finished days per tenant:          up to ${RECOMPUTE_DAYS}\n`);

  if (!apply) {
    console.log('Re-run with --apply to delete the partial rows and recompute.');
    return;
  }

  let deleted = 0, deletedLoc = 0;
  for (const clientId of tenants) {
    const tz = await service.getTimezone(clientId);
    const todayStart = startOfLocalDay(todayKey(tz), tz);
    deleted += (await prisma.dailyInventorySnapshot.deleteMany({
      where: { clientId, snapshotDate: { gte: todayStart } }
    })).count;
    deletedLoc += (await prisma.dailyLocationSnapshot.deleteMany({
      where: { clientId, snapshotDate: { gte: todayStart } }
    })).count;
  }
  console.log(`deleted ${deleted} company-wide and ${deletedLoc} per-location partial row(s)`);

  // Tenants are independent, so they go a few at a time rather than one after another. Days
  // within a tenant stay in order: each is written against the same ledger, but keeping them
  // sequential makes a failure easy to place. Concurrency is capped so the database is not
  // hit with every tenant at once.
  const CONCURRENCY = 6;
  const started = Date.now();
  let written = 0, failed = 0;
  const queue = plan.filter(p => p.days.length);

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      for (const day of next.days) {
        try {
          await service.snapshotDay(next.clientId, day);
          written++;
        } catch (error) {
          failed++;
          console.error(`  ${next.clientId} ${day}: ${(error as Error).message}`);
        }
      }
    }
  }));

  console.log(`recomputed ${written} finished day(s); ${failed} failed  (${Math.round((Date.now() - started) / 1000)}s)`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
