import { SnapshotService } from '../services/snapshot.service';

/**
 * Runs the daily snapshot in-process.
 *
 * The job existed and was never scheduled -- there is no cron here and nothing called it
 * from the server -- so the only rows this table ever held were the fabricated ones the old
 * backfill wrote. A trend chart that nothing feeds is worse than no chart: it looks current.
 *
 * In-process rather than a platform cron because that is the pattern already in use
 * (WebhookDispatcherService.startPolling), it needs no extra service or dashboard config, and
 * it survives a redeploy on its own. The trade is that it only runs while an instance is up:
 * on a host that sleeps when idle, a day with no traffic records nothing. That gap is
 * recoverable -- reconstructFromLedger can rebuild any missing day from the ledger, which is
 * the whole reason it exists.
 */
export class SnapshotScheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static lastRunDay: string | null = null;

  /** Checked hourly rather than timed to midnight, so a restart cannot skip the day. */
  private static readonly CHECK_INTERVAL_MS = 60 * 60 * 1000;

  static start() {
    if (this.timer) return;

    const tick = async () => {
      // UTC day, matching how snapshotDate is normalised. A local-time key would produce two
      // rows for one day, or none, depending on the host's timezone.
      const today = new Date().toISOString().slice(0, 10);
      if (this.lastRunDay === today) return;

      try {
        const service = new SnapshotService();
        const results = await service.runDailyBatch();
        const failed = results.filter(r => !r.success).length;
        this.lastRunDay = today;
        console.log(
          `[SnapshotScheduler] ${today}: recorded ${results.length - failed}/${results.length} tenant(s)` +
          (failed ? `, ${failed} failed` : '')
        );
      } catch (error) {
        // Deliberately does NOT set lastRunDay, so the next hourly tick retries.
        console.error('[SnapshotScheduler] Daily snapshot failed; will retry next hour.', error);
      }
    };

    // A first run on boot means a fresh deployment has today's row immediately rather than
    // waiting up to an hour for the first tick.
    void tick();
    this.timer = setInterval(tick, this.CHECK_INTERVAL_MS);
    // Never hold the process open on this alone.
    this.timer.unref?.();
    console.log('[SnapshotScheduler] Started -- daily inventory snapshots enabled.');
  }

  static stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
