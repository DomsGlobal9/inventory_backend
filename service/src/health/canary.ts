import { randomUUID } from 'node:crypto';
import type { CanaryRun } from '@prisma/client';
import type { Ctx } from '../context';
import { istDayStart, istHour } from '../domain/rules';
import { normalisePhone } from '../lib/phone';
import { getScaleezyAccount } from '../accounts/service';

// Daily early warning: the ScaleEzy number sends a short text to CANARY_TO (default: itself).
// To a second phone it must be DELIVERED within 10 minutes. To itself WhatsApp gives no timely
// tick at all, so it must be sent and confirmed by the engine's own event within 10 minutes.
// A failure here tells us something changed before clients notice.

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
    const m = run.messageId ? await ctx.db.message.findUnique({ where: { id: run.messageId }, include: { account: { select: { phone: true } } } }) : null;
    // Checked on the real engine: a message to one's own number gets no delivered tick, and even
    // the server tick only arrives when the phone next syncs (minutes to hours later). A canary to
    // itself passes once it is sent and the engine's own event about it reached us; a canary to a
    // second phone (CANARY_TO) passes only on the delivered tick.
    const toSelf = Boolean(m && m.account.phone && m.toDigits === m.account.phone);
    if (m && toSelf && m.engineConfirmedAt && m.status !== 'FAILED' && m.status !== 'EXPIRED') {
      const secs = Math.round((m.engineConfirmedAt.getTime() - m.queuedAt.getTime()) / 1000);
      await ctx.db.canaryRun.update({
        where: { id: run.id },
        data: { outcome: 'OK', detail: `Sent to itself and confirmed by the engine in ${secs} s. (Messages to yourself get no delivered tick; set CANARY_TO to a second phone to check delivery too.)` },
      });
      continue;
    }
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
        data: {
          outcome: 'FAILED',
          detail: toSelf
            ? `Not sent and confirmed by the engine within 10 minutes (last status ${m?.status ?? 'unknown'}).`
            : `Not delivered within 10 minutes (last status ${m?.status ?? 'unknown'}).`,
        },
      });
      ctx.log.error({ canaryId: run.id, status: m?.status }, 'canary failed');
    }
  }
}
