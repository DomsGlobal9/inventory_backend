import type { Ctx } from '../context';

/**
 * How long this service keeps what it records. Nothing here is needed for long: a message's PDF
 * is already dropped the moment WhatsApp has it, and every module keeps its own record of what it
 * sent. So finished messages go after MESSAGE_RETENTION_DAYS (30 by default), and the rest after a
 * few days or weeks. Two things are never deleted here:
 *   - a message still QUEUED or SENDING (it is still in use), and
 *   - a STOP (OptOut): the person must never be messaged again, however long ago they asked.
 */
export const RETENTION = {
  moduleEventDays: 7,
  numberCheckDays: 7,
  accountStatusLogDays: 90,
  canaryRunDays: 90,
} as const;

const FINISHED = ['SENT', 'DELIVERED', 'READ', 'FAILED', 'EXPIRED'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PruneResult = { messages: number; moduleEvents: number; numberChecks: number; statusLogs: number; canaryRuns: number };

export async function pruneOldRecords(ctx: Ctx, now = new Date()): Promise<PruneResult> {
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const db = ctx.db;
  const messages = await db.message.deleteMany({
    where: { status: { in: [...FINISHED] }, queuedAt: { lt: before(ctx.config.MESSAGE_RETENTION_DAYS) } },
  });
  // Only events already delivered, or given up on; one still being retried stays.
  const moduleEvents = await db.moduleEvent.deleteMany({
    where: {
      OR: [{ deliveredAt: { lt: before(RETENTION.moduleEventDays) } }, { failedAt: { lt: before(RETENTION.moduleEventDays) } }],
    },
  });
  const numberChecks = await db.numberCheck.deleteMany({ where: { checkedAt: { lt: before(RETENTION.numberCheckDays) } } });
  const statusLogs = await db.accountStatusLog.deleteMany({ where: { at: { lt: before(RETENTION.accountStatusLogDays) } } });
  const canaryRuns = await db.canaryRun.deleteMany({ where: { at: { lt: before(RETENTION.canaryRunDays) } } });
  return {
    messages: messages.count,
    moduleEvents: moduleEvents.count,
    numberChecks: numberChecks.count,
    statusLogs: statusLogs.count,
    canaryRuns: canaryRuns.count,
  };
}
