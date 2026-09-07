import { SnapshotService } from '../services/snapshot.service';

/**
 * Keeps the daily snapshots up to date, in-process.
 *
 * A snapshot is the CLOSING state of a finished business day, so the work is "has any day
 * ended that I have not recorded yet?" rather than "is it midnight?". Each day's closing is
 * derived from the ledger, not from whatever stock happens to be on the shelves when the job
 * fires, so the answer is the same whether this runs at 00:05 or at nine the next morning.
 *
 * That is what makes it safe here. This host sleeps when idle and redeploys whenever we push,
 * so a job that had to fire AT midnight would miss days silently and leave the day book with
 * a wrong opening balance the next morning. Instead each tick catches up everything that is
 * missing, and a machine that was off for three days fills in all three when it wakes.
 *
 * In-process rather than a platform cron because that is the pattern already in use
 * (WebhookDispatcherService.startPolling), it needs no extra service or dashboard config, and
 * it survives a redeploy on its own.
 */
export class SnapshotScheduler {
  private static timer: NodeJS.Timeout | null = null;

  /**
   * Hourly. Tenants keep their own timezones, so midnight arrives at different moments for
   * different shops; checking every hour means no shop waits long after its day ends, and
   * catching up is cheap when there is nothing to do.
   */
  private static readonly CHECK_INTERVAL_MS = 60 * 60 * 1000;

  static start() {
    if (this.timer) return;

    const tick = async () => {
      try {
        const service = new SnapshotService();
        const results = await service.catchUpAll();
        const failed = results.filter(r => !r.success);
        const wrote = results.filter(r => r.written.length > 0);
        if (wrote.length) {
          const days = wrote.reduce((n, r) => n + r.written.length, 0);
          console.log(`[SnapshotScheduler] recorded ${days} closed day(s) across ${wrote.length} tenant(s)`);
        }
        if (failed.length) {
          console.warn(`[SnapshotScheduler] ${failed.length} tenant(s) failed; will retry next hour.`);
        }
      } catch (error) {
        console.error('[SnapshotScheduler] Catch-up failed; will retry next hour.', error);
      }
    };

    // Run on boot so a redeploy immediately fills anything missed while the host was down,
    // rather than waiting up to an hour to notice.
    void tick();
    this.timer = setInterval(tick, this.CHECK_INTERVAL_MS);
    // Never hold the process open on this alone.
    this.timer.unref?.();
    console.log('[SnapshotScheduler] Started -- closing snapshots recorded once each day ends.');
  }

  static stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
