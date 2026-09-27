import { env } from '../config/env';
import { posQueue } from '../services/pos/pos-queue.service';

/**
 * The POS event worker, in-process like the photo-job and Day Book schedulers.
 *
 * No queue library, for the same reason the photo-job worker has none: a claim two servers cannot
 * both win, a retry and a way to find stranded work are a status column and a conditional update
 * against a database this service already has. Redis would be new infrastructure to run, watch
 * and pay for, in a codebase where five other background jobs already work exactly this way.
 *
 * Every two seconds, because somebody is waiting. The photo-job worker ticks every five and that
 * is right for something that takes a minute to produce a photograph, but a shopkeeper who has
 * just rung up a sale will look at their Inventory screen within moments. Two seconds is the
 * difference between "already there" and "not there yet, is it broken?".
 *
 * A development machine points at the PRODUCTION database. A worker that writes sales, moves
 * stock and posts to the ledger is not something to start there by accident, so outside
 * production it stays off unless POS_QUEUE_IN_DEV says otherwise, and POS_QUEUE_ONLY_CLIENTS
 * narrows it to the test shop when it is on.
 */
export class PosQueueScheduler {
  private static timers: NodeJS.Timeout[] = [];
  private static ticking = false;
  private static recovering = false;

  private static readonly TICK_MS = 2 * 1000;
  private static readonly RECOVER_MS = 60 * 1000;

  private static onlyClients(): string[] | undefined {
    const raw = env.POS_QUEUE_ONLY_CLIENTS;
    if (!raw) return undefined;
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }

  static start() {
    if (this.timers.length) return;

    if (env.DISABLE_BACKGROUND_JOBS && !env.POS_QUEUE_IN_DEV) {
      console.log('   POS event worker off (DISABLE_BACKGROUND_JOBS)');
      return;
    }
    if (env.NODE_ENV !== 'production' && !env.POS_QUEUE_IN_DEV) {
      console.log('   POS event worker off (not production; set POS_QUEUE_IN_DEV=true to run it here)');
      return;
    }
    const only = this.onlyClients();
    if (only) console.log(`   POS event worker scoped to: ${only.join(', ')}`);

    const tick = async () => {
      if (this.ticking) return;
      this.ticking = true;
      try {
        await posQueue.tick(only);
      } catch (err) {
        console.error('[pos-queue] tick failed:', (err as Error)?.message);
      } finally {
        this.ticking = false;
      }
    };

    const recover = async () => {
      if (this.recovering) return;
      this.recovering = true;
      try {
        const n = await posQueue.recoverStranded();
        if (n) console.log(`[pos-queue] put ${n} stranded event(s) back on the queue`);
      } catch (err) {
        console.error('[pos-queue] recovery failed:', (err as Error)?.message);
      } finally {
        this.recovering = false;
      }
    };

    this.timers.push(setInterval(tick, this.TICK_MS), setInterval(recover, this.RECOVER_MS));
    this.timers.forEach(t => t.unref?.());

    /*
     * Recovery first, before the first tick, and the order is the point.
     *
     * Every deploy kills whatever was mid-sale, leaving a RUNNING row nothing will finish. A sale
     * is money and stock, so a row stuck that way is not a cosmetic problem -- it is a bill the
     * shop's books do not have. Putting those back before looking for new work means a deploy
     * costs a sale a minute, not a reconciliation.
     */
    void recover().then(tick);
  }

  static stop() {
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
  }
}
