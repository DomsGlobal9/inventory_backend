/**
 * Removes fabricated snapshots and rebuilds real ones from the transaction ledger.
 *
 * The previous backfill wrote today's totals across N past days with random +/-5% variance,
 * so every existing row is invented rather than measured. They cannot be repaired in place --
 * there is no signal in them -- so they are deleted and replaced by a replay of what actually
 * happened.
 *
 *   npx ts-node src/scripts/rebuild-snapshots.ts           # report only
 *   npx ts-node src/scripts/rebuild-snapshots.ts --apply   # purge and rebuild
 */
import { prisma } from '../lib/prisma';
import { SnapshotService } from '../services/snapshot.service';

async function main() {
  const apply = process.argv.includes('--apply');
  const service = new SnapshotService();

  // Every row dated before today came from the fabricating backfill: the daily job was never
  // scheduled until now, so nothing has ever measured a past day. Rows dated today ARE real
  // measurements and must survive -- particularly for tenants whose history cannot be
  // rebuilt, where that row is the only true datum they have.
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const fabricated = await prisma.dailyInventorySnapshot.count({
    where: { snapshotDate: { lt: todayUtc } }
  });
  const measuredToday = await prisma.dailyInventorySnapshot.count({
    where: { snapshotDate: { gte: todayUtc } }
  });
  console.log(`fabricated rows (dated before today): ${fabricated}`);
  console.log(`real rows measured today:             ${measuredToday}  <- kept\n`);

  const tenants = await service.getActiveTenants();
  const plans: { clientId: string; days: number; ok: boolean; reason: string }[] = [];

  for (const clientId of tenants) {
    const result = await service.reconstructFromLedger(clientId, { apply: false });
    plans.push({
      clientId,
      days: result.days,
      ok: result.verification.ok,
      reason: result.verification.reason
    });
    const mark = result.days === 0 ? '   ' : result.verification.ok ? ' OK' : 'BAD';
    console.log(`[${mark}] ${clientId}: ${result.days} day(s) -- ${result.verification.reason}`);
  }

  const rebuildable = plans.filter(p => p.days > 0 && p.ok);
  const untrustworthy = plans.filter(p => p.days > 0 && !p.ok);

  console.log(`\nrebuildable tenants: ${rebuildable.length}`);
  console.log(`tenants whose ledger does not reconcile: ${untrustworthy.length}`);

  if (!apply) {
    console.log('\nRe-run with --apply to purge the fabricated rows and write the replay.');
    return;
  }

  const purged = await prisma.dailyInventorySnapshot.deleteMany({
    where: { snapshotDate: { lt: todayUtc } }
  });
  console.log(`\npurged ${purged.count} fabricated row(s); today's real measurements untouched`);

  let written = 0;
  for (const plan of rebuildable) {
    const result = await service.reconstructFromLedger(plan.clientId, { apply: true });
    if (result.applied) {
      written += result.days;
      console.log(`  rebuilt ${result.days} day(s) for ${plan.clientId}`);
    }
  }
  console.log(`\nwrote ${written} reconstructed day(s) across ${rebuildable.length} tenant(s)`);

  if (untrustworthy.length) {
    console.log('\nLeft empty (ledger does not reconcile, so any history would be a guess):');
    for (const p of untrustworthy) console.log(`  ${p.clientId} -- ${p.reason}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
