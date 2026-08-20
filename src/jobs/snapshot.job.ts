import { SnapshotService } from '../services/snapshot.service';

async function run() {
  console.log('[SnapshotJob] Starting daily inventory snapshot job...');
  const snapshotService = new SnapshotService();
  const results = await snapshotService.runDailyBatch();
  
  let successCount = 0;
  let failCount = 0;

  for (const res of results) {
    if (res.success) {
      console.log(`[SnapshotJob] Success for tenant ${res.clientId}`);
      successCount++;
    } else {
      console.error(`[SnapshotJob] Failed for tenant ${res.clientId}:`, res.error);
      failCount++;
    }
  }

  console.log(`[SnapshotJob] Finished. Success: ${successCount}, Failed: ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

run().catch(error => {
  console.error('[SnapshotJob] Unhandled error:', error);
  process.exit(1);
});
