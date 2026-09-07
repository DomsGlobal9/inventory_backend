import { SnapshotService } from '../services/snapshot.service';

async function run() {
  console.log('[SnapshotJob] Recording any business day that has closed since the last run...');
  const snapshotService = new SnapshotService();
  const results = await snapshotService.catchUpAll();
  
  let successCount = 0;
  let failCount = 0;

  for (const res of results) {
    if (res.success) {
      const days = res.written.length;
      console.log(`[SnapshotJob] ${res.clientId}: ${days ? `recorded ${days} day(s): ${res.written.join(', ')}` : 'already up to date'}`);
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
