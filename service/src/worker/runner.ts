import type { Ctx } from '../context';
import { dispatchDueEvents } from '../events/module-events';
import { runHealthWatch } from '../health/watch';
import { canaryTick, settleCanaries } from '../health/canary';
import { LeaderLock } from './leader';
import { Sender } from './sender';

// Background work of one service instance. Everything here runs only while this instance holds
// the sender lock, so with several instances exactly one sends, pushes webhooks and watches.

export interface RunnerOptions {
  lockKey?: number;
  leaderPollMs?: number;
  dispatchEveryMs?: number;
  housekeepingEveryMs?: number;
  healthConfirmDelayMs?: number;
  rand?: () => number;
  notReadyWaitMs?: number;
}

const STUCK_TASK_MS = 5 * 60 * 1000;

interface Task {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  running: boolean;
  lastRun: number;
  startedAt: number;
}

export class Runner {
  readonly lock: LeaderLock;
  readonly sender: Sender;
  private readonly tasks: Task[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private wasLeader = false;
  private lastLeaderTry = 0;
  private loopRunning: Promise<void> | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: RunnerOptions = {},
  ) {
    this.lock = new LeaderLock(ctx.config.DATABASE_URL, ctx.log, opts.lockKey);
    this.sender = new Sender(ctx, { ...(opts.rand ? { rand: opts.rand } : {}), ...(opts.notReadyWaitMs !== undefined ? { notReadyWaitMs: opts.notReadyWaitMs } : {}) });
    const c = ctx.config;
    this.addTask('send', c.WORKER_TICK_MS, () => this.sender.tick());
    this.addTask('dispatch-webhooks', opts.dispatchEveryMs ?? 2000, () => dispatchDueEvents(ctx));
    this.addTask('housekeeping', opts.housekeepingEveryMs ?? 60_000, () => this.housekeeping());
    this.addTask('health-watch', c.HEALTH_WATCH_INTERVAL_MS, () =>
      runHealthWatch(ctx, opts.healthConfirmDelayMs !== undefined ? { confirmDelayMs: opts.healthConfirmDelayMs } : {}),
    );
    this.addTask('canary', 60_000, async () => {
      await canaryTick(ctx);
      await settleCanaries(ctx);
    });
  }

  get isLeader(): boolean {
    return this.lock.isHeld;
  }

  private addTask(name: string, everyMs: number, run: () => Promise<unknown>): void {
    this.tasks.push({ name, everyMs, run, running: false, lastRun: 0, startedAt: 0 });
  }

  start(): void {
    const tickMs = Math.min(250, this.ctx.config.WORKER_TICK_MS);
    const loop = () => {
      if (this.stopping) return;
      this.loopRunning = this.loopOnce()
        .catch((e) => this.ctx.log.error({ err: e }, 'runner loop error'))
        .finally(() => {
          this.loopRunning = null;
          if (!this.stopping) this.timer = setTimeout(loop, tickMs);
        });
    };
    loop();
  }

  private async loopOnce(): Promise<void> {
    const now = Date.now();
    if (!this.lock.isHeld) {
      if (this.wasLeader) {
        this.wasLeader = false;
        this.ctx.log.warn('this instance is no longer the sender');
      }
      if (now - this.lastLeaderTry < (this.opts.leaderPollMs ?? 5000)) return;
      this.lastLeaderTry = now;
      if (!(await this.lock.tryAcquire())) return;
    }
    if (!this.wasLeader) {
      this.wasLeader = true;
      this.ctx.log.info('this instance is now the sender');
      for (const t of this.tasks) t.lastRun = t.name === 'health-watch' ? now - t.everyMs + 10_000 : 0;
      await this.sender.recoverStale();
    }
    for (const t of this.tasks) {
      if (this.stopping || !this.lock.isHeld) return;
      if (t.running && now - t.startedAt > STUCK_TASK_MS) {
        // Every call inside has its own time limit, so this should never happen; if it does,
        // a stuck task must not stop sending for good.
        this.ctx.log.error({ task: t.name }, "background task stuck for 5 minutes; starting a new run");
        t.running = false;
      }
      if (t.running || now - t.lastRun < t.everyMs) continue;
      t.lastRun = now;
      t.startedAt = now;
      t.running = true;
      // Tasks run side by side; one slow task (a dead module webhook) never holds up sending.
      void t
        .run()
        .catch((e) => this.ctx.log.error({ err: e, task: t.name }, 'background task failed'))
        .finally(() => {
          t.running = false;
        });
    }
  }

  private async housekeeping(): Promise<void> {
    if (!(await this.lock.heartbeat())) return;
    await this.sender.expireOld();
    await this.sender.recoverStale();
    // Ticks that never matched a message (e.g. sent from the phone itself) are not kept.
    await this.ctx.db.engineReceipt.deleteMany({ where: { at: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
  }

  /**
   * Graceful stop: no new work, let the send in progress finish, then give up the lock so
   * another instance can take over at once.
   */
  async stop(timeoutMs = 28_000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.sender.stop();
    if (this.loopRunning) await this.loopRunning.catch(() => undefined);
    const drained = await this.sender.drain(timeoutMs);
    if (!drained) this.ctx.log.warn('stopped while a send was still running; it will be recovered');
    await this.lock.release();
  }
}
