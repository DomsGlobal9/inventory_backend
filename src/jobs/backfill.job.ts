/**
 * Rebuilds historical snapshots from the transaction ledger.
 *
 * This job used to call runBackfill, which wrote today's totals across the last 30 days with
 * random +/-5% variance -- inventing a trend rather than recording one. It now replays what
 * actually happened, and refuses to write for any tenant whose replay does not reproduce the
 * stock the database currently holds.
 *
 *   npm run snapshots:backfill
 */
import { prisma } from '../lib/prisma';
import { SnapshotService } from '../services/snapshot.service';

async function run() {
  console.log('[BackfillJob] Reconstructing snapshots from the ledger...');
  const service = new SnapshotService();
  const tenants = await service.getActiveTenants();

  let written = 0;
  let skipped = 0;

  for (const clientId of tenants) {
    try {
      const result = await service.reconstructFromLedger(clientId, { apply: true });
      if (result.applied) {
        written += result.days;
        console.log(`[BackfillJob] ${clientId}: rebuilt ${result.days} day(s)`);
      } else {
        skipped++;
        console.warn(`[BackfillJob] ${clientId}: skipped -- ${result.verification.reason}`);
      }
    } catch (error) {
      skipped++;
      console.error(`[BackfillJob] ${clientId}: failed`, error);
    }
  }

  console.log(`[BackfillJob] Finished. ${written} day(s) written, ${skipped} tenant(s) skipped.`);
  await prisma.$disconnect();
  process.exit(0);
}

run().catch(async error => {
  console.error('[BackfillJob] Unhandled error:', error);
  await prisma.$disconnect();
  process.exit(1);
});
