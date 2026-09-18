import { randomUUID } from 'node:crypto';
import type { CanaryRun } from '@prisma/client';
import type { Ctx } from '../context';
import { istDayStart, istHour } from '../domain/rules';
import { normalisePhone } from '../lib/phone';
import { getScaleezyAccount } from '../accounts/service';

// Daily early warning: the ScaleEzy number sends a short text to CANARY_TO (default: itself)
// and expects the delivered tick within 10 minutes. A failure here tells us WhatsApp changed
// something before clients notice.

export const CANARY_DEADLINE_MS = 10 * 60 * 1000;

/** Queues today's canary if it is due. Returns the run, or null when nothing was started. */
export async function canaryTick(ctx: Ctx, now = new Date()): Promise<CanaryRun | null> {
  if (!ctx.config.CANARY_ENABLED) return null;
  if (istHour(now) < ctx.config.CANARY_HOUR_IST) return null;
  const today = await ctx.db.canaryRun.findFirst({ where: { at: { gte: istDayStart(now) } } });
  if (today) return null;
  return startCanary(ctx);
}

export async function startCanary(ctx: Ctx): Promise<CanaryRun> {
  const account = await getScaleezyAccount(ctx);
  if (!account) return ctx.db.canaryRun.create({ data: { outcome: 'FAILED', detail: 'The ScaleEzy number is not set up.' } });
  const to = (ctx.config.canaryTo ? normalisePhone(ctx.config.canaryTo) : null) ?? account.phone;
  if (!to) return ctx.db.canaryRun.create({ data: { outcome: 'FAILED', detail: 'No canary number: set CANARY_TO or link the ScaleEzy number.' } });
  if (account.status !== 'CONNECTED') {
    return ctx.db.canaryRun.create({ data: { outcome: 'FAILED', detail: `The ScaleEzy number is ${account.status}.` } });
  }
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const message = await ctx.db.message.create({
    data: {
      accountId: account.id,
      moduleId: null,
      toDigits: to,
      kind: 'TEST',
      reference: 'canary',
      idempotencyKey: `canary-${randomUUID()}`,
      contentHash: randomUUID(),
      text: `ScaleEzy WhatsApp daily check (${stamp} UTC). No reply needed.`,
    },
  });
  ctx.log.info({ messageId: message.id }, 'canary queued');
  return ctx.db.canaryRun.create({ data: { messageId: message.id, outcome: 'PENDING' } });
}

/** Settles pending canaries: OK once delivered, FAILED if not delivered within 10 minutes. */
export async function settleCanaries(ctx: Ctx, now = new Date()): Promise<void> {
  const pending = await ctx.db.canaryRun.findMany({ where: { outcome: 'PENDING' } });
  for (const run of pending) {
    const m = run.messageId ? await ctx.db.message.findUnique({ where: { id: run.messageId } }) : null;
    if (m && (m.status === 'DELIVERED' || m.status === 'READ')) {
      const secs = m.deliveredAt ? Math.round((m.deliveredAt.getTime() - m.queuedAt.getTime()) / 1000) : null;
      await ctx.db.canaryRun.update({ where: { id: run.id }, data: { outcome: 'OK', detail: `Delivered${secs !== null ? ` in ${secs} s` : ''}.` } });
      continue;
    }
    if (m && (m.status === 'FAILED' || m.status === 'EXPIRED')) {
      await ctx.db.canaryRun.update({ where: { id: run.id }, data: { outcome: 'FAILED', detail: `Message ${m.status}: ${m.failReason ?? ''}`.trim() } });
      continue;
    }
    if (now.getTime() - run.at.getTime() > CANARY_DEADLINE_MS) {
      await ctx.db.canaryRun.update({
        where: { id: run.id },
        data: { outcome: 'FAILED', detail: `Not delivered within 10 minutes (last status ${m?.status ?? 'unknown'}).` },
      });
      ctx.log.error({ canaryId: run.id, status: m?.status }, 'canary failed');
    }
  }
}
