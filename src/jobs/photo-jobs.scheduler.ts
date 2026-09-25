import { env } from '../config/env';
import { PhotoJobRunner } from '../services/photo-jobs';

/**
 * The photo-job worker, in-process like the campaigns and Day Book schedulers.
 *
 * No queue library, deliberately. Everything a BullMQ would buy here -- a claim two servers
 * cannot both win, a retry, a way to find stranded work -- is a status column and a conditional
 * update against a database this service already has. Adding Redis to get them would be new
 * infrastructure to run, watch and pay for, in a codebase where four other background jobs
 * already work exactly this way.
 *
 * Every few seconds: claim whatever is waiting, up to the concurrency limit.
 * Every minute: put back anything a dead instance left on RUNNING.
 *
 * Making a set of photographs spends a shop's paid generations, and a development machine points
 * at the production database -- so outside production this stays off unless PHOTO_JOBS_IN_DEV
 * says otherwise, and PHOTO_JOBS_ONLY_CLIENTS narrows it to the test shop when it is on.
 */
export class PhotoJobsScheduler {
  private static timers: NodeJS.Timeout[] = [];
  private static ticking = false;
  private static recovering = false;

  private static readonly TICK_MS = 5 * 1000;
  private static readonly RECOVER_MS = 60 * 1000;

  static start() {
    if (this.timers.length) return;

    /*
     * The instance switch still wins, unless somebody has explicitly said otherwise.
     *
     * A development machine points at the production database and turns DISABLE_BACKGROUND_JOBS
     * on so it does not write snapshots or dispatch events. Photo jobs are safe to run twice --
     * the claim settles that -- but they still spend a shop's paid generations, so running them
     * there has to be asked for by name rather than assumed.
     */
    if (env.DISABLE_BACKGROUND_JOBS && !env.PHOTO_JOBS_IN_DEV) {
      console.log('   Photo jobs worker off (DISABLE_BACKGROUND_JOBS)');
      return;
    }
    if (env.NODE_ENV !== 'production' && !env.PHOTO_JOBS_IN_DEV) {
      console.log('   Photo jobs worker off (not production; set PHOTO_JOBS_IN_DEV=true to run it here)');
      return;
    }
    if (env.PHOTO_JOBS_ONLY_CLIENTS) {
      console.log(`   Photo jobs worker scoped to: ${env.PHOTO_JOBS_ONLY_CLIENTS}`);
    }

    const tick = async () => {
      if (this.ticking) return;
      this.ticking = true;
      try {
        await PhotoJobRunner.tick();
      } catch (err) {
        console.error('[photo-jobs] tick failed:', (err as Error)?.message);
      } finally {
        this.ticking = false;
      }
    };

    const recover = async () => {
      if (this.recovering) return;
      this.recovering = true;
      try {
        await PhotoJobRunner.recoverStranded();
      } catch (err) {
        console.error('[photo-jobs] recovery failed:', (err as Error)?.message);
      } finally {
        this.recovering = false;
      }
    };

    this.timers.push(setInterval(tick, this.TICK_MS), setInterval(recover, this.RECOVER_MS));
    this.timers.forEach(t => t.unref?.());

    /*
     * Recovery runs FIRST, before the first tick, and this order is the whole point of it.
     *
     * Every push redeploys this service and kills whatever was mid-generation, leaving a RUNNING
     * row nothing will ever finish. Putting those back on the queue before looking for new work
     * means a shop whose photographs were interrupted by a deploy gets them a minute later
     * instead of watching "being made" until somebody notices.
     */
    void recover().then(tick);
  }
}
