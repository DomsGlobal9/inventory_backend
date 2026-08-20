import { SnapshotService } from '../services/snapshot.service';

async function run() {
  console.log('[BackfillJob] Starting 30-day inventory snapshot backfill...');
  const snapshotService = new SnapshotService();
  const results = await snapshotService.runBackfill(30);
  
  let successCount = 0;
  let failCount = 0;

  for (const res of results) {
    if (res.success) {
      console.log(`[BackfillJob] Success for tenant ${res.clientId} (${res.daysBackfilled} days)`);
      successCount++;
    } else {
      console.error(`[BackfillJob] Failed for tenant ${res.clientId}:`, res.error);
      failCount++;
    }
  }

  console.log(`[BackfillJob] Finished. Success: ${successCount}, Failed: ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

run().catch(error => {
  console.error('[BackfillJob] Unhandled error:', error);
  process.exit(1);
});
