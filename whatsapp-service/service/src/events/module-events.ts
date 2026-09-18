import type { Prisma } from '@prisma/client';
import { decrypt, signBody } from '../lib/crypto';
import type { Ctx } from '../context';

// Events for modules (delivery ticks, account drops, STOP replies) are written to the
// ModuleEvent table in the same step as the change they describe, then pushed by the
// dispatcher. A crash between the two only delays an event; it never loses one. The module
// may see the same event twice (at-least-once) and dedupes by its `id`.

export type ModuleEventType =
  | 'message.status'
  | 'account.connected'
  | 'account.disconnected'
  | 'account.status'
  | 'contact.opted_out';

type Tx = Prisma.TransactionClient;

export const MAX_WEBHOOK_TRIES = 3;
/** Wait after failed try n: 10 s, then 60 s. */
export function webhookBackoffMs(tries: number): number {
  return tries <= 1 ? 10_000 : 60_000;
}

export async function enqueueForModule(tx: Tx, moduleId: string, type: ModuleEventType, data: Record<string, unknown>): Promise<void> {
  const mod = await tx.moduleClient.findUnique({ where: { id: moduleId }, select: { active: true, webhookUrl: true } });
  if (!mod?.active || !mod.webhookUrl) return;
  await tx.moduleEvent.create({ data: { moduleId, type, payload: data as Prisma.InputJsonValue } });
}

/** Account-level events go to every active module that has a webhook. */
export async function enqueueForAllModules(tx: Tx, type: ModuleEventType, data: Record<string, unknown>): Promise<void> {
  const mods = await tx.moduleClient.findMany({ where: { active: true, webhookUrl: { not: null } }, select: { id: true } });
  if (mods.length === 0) return;
  await tx.moduleEvent.createMany({
    data: mods.map((m) => ({ moduleId: m.id, type, payload: data as Prisma.InputJsonValue })),
  });
}

export interface DispatchResult {
  delivered: number;
  retried: number;
  failed: number;
}

/**
 * Pushes due events. One slow or dead module webhook never blocks sending: this runs on its
 * own timer, each request has a short timeout, and a failure only reschedules that event.
 */
export async function dispatchDueEvents(ctx: Ctx, batch = 20, timeoutMs = 10_000): Promise<DispatchResult> {
  const now = new Date();
  const due = await ctx.db.moduleEvent.findMany({
    where: { deliveredAt: null, failedAt: null, nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: batch,
    include: { module: { select: { name: true, webhookUrl: true, webhookSecretEncrypted: true, active: true } } },
  });
  const result: DispatchResult = { delivered: 0, retried: 0, failed: 0 };

  await Promise.all(
    due.map(async (ev) => {
      const body = JSON.stringify({ id: ev.id, type: ev.type, occurredAt: ev.createdAt.toISOString(), data: ev.payload });
      let error: string | null = null;
      if (!ev.module.active || !ev.module.webhookUrl) {
        error = 'module has no webhook';
      } else {
        try {
          const secret = ev.module.webhookSecretEncrypted ? decrypt(ev.module.webhookSecretEncrypted, ctx.config.ENCRYPTION_KEY) : '';
          const res = await fetch(ev.module.webhookUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-event-id': ev.id,
              'x-event-type': ev.type,
              'x-signature': signBody(secret, body),
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) error = `HTTP ${res.status}`;
          await res.body?.cancel().catch(() => undefined);
        } catch (e) {
          error = (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable';
        }
      }

      if (!error) {
        await ctx.db.moduleEvent.update({ where: { id: ev.id }, data: { deliveredAt: new Date(), tries: { increment: 1 }, lastError: null } });
        result.delivered++;
        return;
      }
      const tries = ev.tries + 1;
      if (tries >= MAX_WEBHOOK_TRIES) {
        await ctx.db.moduleEvent.update({ where: { id: ev.id }, data: { tries, failedAt: new Date(), lastError: error } });
        ctx.log.warn({ eventId: ev.id, eventType: ev.type, module: ev.module.name, error }, 'module webhook failed 3 times; event recorded as failed');
        result.failed++;
      } else {
        await ctx.db.moduleEvent.update({
          where: { id: ev.id },
          data: { tries, lastError: error, nextAttemptAt: new Date(Date.now() + webhookBackoffMs(tries)) },
        });
        result.retried++;
      }
    }),
  );
  return result;
}
