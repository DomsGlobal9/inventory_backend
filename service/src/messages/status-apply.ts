import type { Message, MessageStatus, Prisma } from '@prisma/client';
import type { Ctx } from '../context';
import { advanceStatus, mapEngineMessageStatus } from '../domain/status';
import { enqueueForModule } from '../events/module-events';

type Tx = Prisma.TransactionClient;

export interface ApplyOptions {
  failReason?: string;
  engineMessageId?: string;
  at?: Date;
}

/**
 * The one place a message's status changes. Locks the row, applies only forward moves (see
 * advanceStatus), wipes the document once it is no longer needed, and queues the module's
 * `message.status` event in the same transaction. Returns the updated row, or null when the
 * event changed nothing (duplicate or late), in which case the module hears nothing new.
 */
export async function applyMessageStatus(ctx: Ctx, messageId: string, incoming: MessageStatus, opts: ApplyOptions = {}): Promise<Message | null> {
  return ctx.db.$transaction((tx) => applyInTx(tx, messageId, incoming, opts));
}

export async function applyInTx(tx: Tx, messageId: string, incoming: MessageStatus, opts: ApplyOptions = {}): Promise<Message | null> {
  const rows = await tx.$queryRaw<Array<{ status: MessageStatus }>>`
    SELECT status FROM "Message" WHERE id = ${messageId} FOR UPDATE`;
  const current = rows[0]?.status;
  if (!current) return null;
  const next = advanceStatus(current, incoming);
  if (!next) {
    // Still record the engine id if we learnt it (e.g. a late "sent" after "delivered").
    if (opts.engineMessageId) {
      await tx.message.updateMany({ where: { id: messageId, engineMessageId: null }, data: { engineMessageId: opts.engineMessageId } });
    }
    return null;
  }
  const at = opts.at ?? new Date();
  const existing = await tx.message.findUniqueOrThrow({
    where: { id: messageId },
    select: { sentAt: true, deliveredAt: true, moduleId: true, engineMessageId: true },
  });
  const data: Prisma.MessageUpdateInput = { status: next };
  if (opts.engineMessageId && !existing.engineMessageId) data.engineMessageId = opts.engineMessageId;
  if (next === 'SENT' || next === 'DELIVERED' || next === 'READ') {
    if (!existing.sentAt) data.sentAt = at;
    data.failReason = null;
    data.failedAt = null;
  }
  if ((next === 'DELIVERED' || next === 'READ') && !existing.deliveredAt) data.deliveredAt = at;
  if (next === 'READ') data.readAt = at;
  if (next === 'FAILED' || next === 'EXPIRED') {
    data.failedAt = at;
    data.failReason = opts.failReason ?? (next === 'EXPIRED' ? 'Not sent within a day, so it was not sent late.' : 'WhatsApp could not deliver this message.');
  }
  // The PDF is only kept until WhatsApp has it (or it will never be sent).
  if (next !== 'SENDING') data.document = null;

  const m = await tx.message.update({ where: { id: messageId }, data });
  if (m.moduleId) {
    await enqueueForModule(tx, m.moduleId, 'message.status', {
      messageId: m.id,
      reference: m.reference,
      kind: m.kind,
      status: m.status,
      failReason: m.failReason,
      sentAt: m.sentAt?.toISOString() ?? null,
      deliveredAt: m.deliveredAt?.toISOString() ?? null,
      readAt: m.readAt?.toISOString() ?? null,
      failedAt: m.failedAt?.toISOString() ?? null,
    });
  }
  return m;
}

/**
 * The worker learnt the engine id of a message it sent. Any ticks that arrived before (the
 * engine can report "delivered" before its send call returns) are applied now.
 */
export async function recordSent(ctx: Ctx, messageId: string, engineMessageId: string): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    await applyInTx(tx, messageId, 'SENT', { engineMessageId });
    const early = await tx.engineReceipt.findUnique({ where: { engineMessageId } });
    if (early) {
      const s = mapEngineMessageStatus(early.status);
      if (s) await applyInTx(tx, messageId, s, { at: early.at });
      await tx.engineReceipt.delete({ where: { engineMessageId } });
    }
  });
}
