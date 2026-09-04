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

  /** Hourly rather than timed to midnight, so a restart cannot skip a day. */
  private static readonly CHECK_INTERVAL_MS = 60 * 60 * 1000;

  static start() {
    if (this.timer) return;

    const tick = async () => {
      // Runs every hour with no "already done today" guard, deliberately.
      //
      // Each tenant is dated by its OWN timezone, so a single process-wide day key would be
      // wrong for anyone not sharing the server's calendar -- it would skip a tenant whose
      // day had already rolled over. And because takeSnapshot upserts on (client, day), a
      // repeat is harmless: it refreshes today's row rather than adding one. The last write
      // before midnight is therefore the day's true closing figure, which is exactly what an
      // opening balance needs to read the next morning.
      try {
        const service = new SnapshotService();
        const results = await service.runDailyBatch();
        const failed = results.filter(r => !r.success).length;
        if (failed) {
          console.warn(`[SnapshotScheduler] recorded ${results.length - failed}/${results.length} tenant(s), ${failed} failed`);
        }
      } catch (error) {
        console.error('[SnapshotScheduler] Snapshot run failed; will retry next hour.', error);
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
