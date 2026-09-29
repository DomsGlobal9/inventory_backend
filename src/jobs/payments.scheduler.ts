import { env } from '../config/env';
import * as onlinePayments from '../services/payments/online-payment.service';

/**
 * The online-payment sweeper, once a minute.
 *
 * It was written and never started, which is the worst way for this particular job to be missing.
 * Without it an abandoned checkout holds its stock FOR EVER -- the hold is only let go from here --
 * a payment whose webhook was lost is never confirmed, a UPI approval that arrives after the hold
 * lapsed is never honoured or returned, and a refund whose answer was lost in transit stays
 * "requesting" with the customer's money nowhere.
 *
 * Every step inside is safe on two servers at once (claims are conditional updates under row and
 * advisory locks), so unlike the snapshot job this does not need DISABLE_BACKGROUND_JOBS to keep it
 * to one instance -- though it honours that switch by default, like the other workers.
 *
 * Outside production it stays off unless PAYMENTS_SWEEP_IN_DEV says so, and PAYMENTS_SWEEP_ONLY_CLIENTS
 * narrows it to test shops: a laptop pointed at the production database must not be letting go of
 * real customers' holds.
 */
export class PaymentsScheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static lastProblem = '';
  private static readonly TICK_MS = 60 * 1000;

  private static onlyClients(): string[] | undefined {
    const list = (env.PAYMENTS_SWEEP_ONLY_CLIENTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }

  static start() {
    if (this.timer) return;
    if (env.DISABLE_BACKGROUND_JOBS && !env.PAYMENTS_SWEEP_IN_DEV) {
      console.log('   payments sweeper off (DISABLE_BACKGROUND_JOBS)');
      return;
    }
    if (env.NODE_ENV !== 'production' && !env.PAYMENTS_SWEEP_IN_DEV) {
      console.log('   payments sweeper off (not production; set PAYMENTS_SWEEP_IN_DEV=true to run it here)');
      return;
    }
    const only = this.onlyClients();
    if (only) console.log(`   payments sweeper scoped to: ${only.join(', ')}`);

    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const done = await onlinePayments.sweep(50, only);
        const moved = Object.entries(done).filter(([, n]) => n > 0);
        if (moved.length) console.log(`[payments] sweep: ${moved.map(([k, n]) => `${k} ${n}`).join(', ')}`);
        if (this.lastProblem) { console.log('[payments] sweeper working again'); this.lastProblem = ''; }
      } catch (err) {
        // Once per distinct problem, not once a minute for as long as it lasts.
        const what = String((err as Error)?.message ?? err).split(/\r?\n/).find(Boolean)?.slice(0, 200) ?? 'unknown problem';
        if (what !== this.lastProblem) console.error(`[payments] sweep failed: ${what}`);
        this.lastProblem = what;
      } finally {
        this.running = false;
      }
    };

    this.timer = setInterval(tick, this.TICK_MS);
    this.timer.unref?.();
    // Shortly after boot too: a redeploy is exactly when holds lapse and answers go missing.
    setTimeout(() => { void tick(); }, 15_000).unref?.();
  }
}
