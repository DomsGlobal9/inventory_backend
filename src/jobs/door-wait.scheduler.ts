import { env } from '../config/env';
import { doorCheckins } from '../services/door-checkin';

/**
 * Customers waiting at a store's door (29 Oct), once a minute: after WAIT_ALERT_MS with nobody taking
 * them, the owner's bell and one "sorry for the wait" (services/door-checkin waitTick). Safe on two
 * servers at once (each arrival is claimed before anything is sent). Off where background jobs are
 * off, unless DOOR_WAIT_IN_DEV says so -- a laptop on a shared database must not write to real shoppers.
 */
export class DoorWaitScheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static lastProblem = '';
  private static readonly TICK_MS = 60 * 1000;

  static start() {
    if (this.timer) return;
    const inDev = process.env.DOOR_WAIT_IN_DEV === 'true';
    if (env.DISABLE_BACKGROUND_JOBS && !inDev) { console.log('   door waiting alerts off (DISABLE_BACKGROUND_JOBS)'); return; }
    if (env.NODE_ENV !== 'production' && !inDev) { console.log('   door waiting alerts off (not production; DOOR_WAIT_IN_DEV=true to run here)'); return; }
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const { raised } = await doorCheckins.waitTick();
        if (raised) console.log(`[door] waiting alerts: ${raised}`);
        this.lastProblem = '';
      } catch (err) {
        const what = String((err as Error)?.message ?? err).split(/\r?\n/).find(Boolean)?.slice(0, 200) ?? 'unknown problem';
        if (what !== this.lastProblem) console.error(`[door] waiting alerts failed: ${what}`);
        this.lastProblem = what;
      } finally { this.running = false; }
    };
    this.timer = setInterval(tick, this.TICK_MS);
    this.timer.unref?.();
  }
}
