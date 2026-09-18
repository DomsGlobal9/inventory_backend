import type { Ctx } from '../context';
import { mapConnectionState, mapEngineMessageStatus, advanceStatus, isServerTick } from '../domain/status';
import { digitsFromJid } from '../lib/phone';
import { applyMessageStatus, recordSent } from '../messages/status-apply';
import { setAccountStatus } from '../accounts/service';
import { enqueueForAllModules } from './module-events';

// Events pushed by the engine (Evolution's global webhook). Each handler is idempotent: the
// engine may send an event twice or out of order, and the health watch may already have
// recorded the same change.

export interface EnginePayload {
  event?: string;
  instance?: string;
  data?: unknown;
}

const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'STOP ALL']);
/** How far back a send.message event may match a message we were sending (see onSendMessage). */
const CORRELATE_WINDOW_MS = 10 * 60 * 1000;

export async function handleEngineEvent(ctx: Ctx, payload: EnginePayload): Promise<void> {
  const event = String(payload.event ?? '').toLowerCase().replace(/_/g, '.');
  const instance = typeof payload.instance === 'string' ? payload.instance : null;
  if (!instance) return;
  const data = (payload.data ?? {}) as Record<string, unknown>;

  switch (event) {
    case 'connection.update':
      return onConnectionUpdate(ctx, instance, data);
    case 'qrcode.updated':
      return onQrUpdated(ctx, instance);
    case 'messages.update':
      return onMessagesUpdate(ctx, Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [data]);
    case 'send.message':
      return onSendMessage(ctx, instance, data);
    case 'messages.upsert':
      return onMessagesUpsert(ctx, instance, data);
    default:
      return;
  }
}

async function onConnectionUpdate(ctx: Ctx, instance: string, data: Record<string, unknown>): Promise<void> {
  const account = await ctx.db.account.findUnique({ where: { instanceName: instance } });
  if (!account) return;
  const state = String(data.state ?? '');
  const statusReason = typeof data.statusReason === 'number' ? data.statusReason : null;
  const to = mapConnectionState({ state, statusReason }, account.linkedAt !== null);
  if (to === 'CONNECTED') {
    await setAccountStatus(ctx, account.id, 'CONNECTED', 'engine-event', {
      phone: digitsFromJid(typeof data.wuid === 'string' ? data.wuid : null),
      displayName: typeof data.profileName === 'string' ? data.profileName : null,
    });
    return;
  }
  if (to === 'LOGGED_OUT') {
    await setAccountStatus(ctx, account.id, 'LOGGED_OUT', 'engine-event');
    return;
  }
  // A linked number that closes or starts reconnecting usually comes back within seconds (engine
  // restart, network blip). The health watch confirms real drops, so owners are not alarmed by blips.
  if (account.linkedAt === null && account.status === 'LINKING' && to === 'NOT_LINKED') {
    await setAccountStatus(ctx, account.id, 'NOT_LINKED', 'engine-event');
  }
}

async function onQrUpdated(ctx: Ctx, instance: string): Promise<void> {
  const account = await ctx.db.account.findUnique({ where: { instanceName: instance } });
  if (!account) return;
  // A new QR for a number we think is connected means its link is gone.
  if (account.status === 'CONNECTED' || account.status === 'DISCONNECTED') {
    await setAccountStatus(ctx, account.id, 'LOGGED_OUT', 'engine-qr');
  }
}

async function onMessagesUpdate(ctx: Ctx, updates: Record<string, unknown>[]): Promise<void> {
  for (const u of updates) {
    const keyId = typeof u.keyId === 'string' ? u.keyId : null;
    if (!keyId || u.fromMe === false) continue;
    const status = mapEngineMessageStatus(u.status);
    if (!status) continue;
    const msg = await ctx.db.message.findUnique({ where: { engineMessageId: keyId }, select: { id: true } });
    if (msg) {
      await applyMessageStatus(ctx, msg.id, status, status === 'FAILED' ? { failReason: 'WhatsApp could not deliver this message.' } : { serverAck: isServerTick(u.status) });
      continue;
    }
    // Tick for a message whose send call has not returned yet: keep it, the worker applies it.
    const prev = await ctx.db.engineReceipt.findUnique({ where: { engineMessageId: keyId } });
    const prevStatus = prev ? mapEngineMessageStatus(prev.status) : null;
    if (!prev) {
      await ctx.db.engineReceipt.create({ data: { engineMessageId: keyId, status: String(u.status) } }).catch(() => undefined);
    } else if (prevStatus && advanceStatus(prevStatus, status)) {
      await ctx.db.engineReceipt.update({ where: { engineMessageId: keyId }, data: { status: String(u.status), at: new Date() } });
    }
  }
}

/**
 * `send.message` is emitted only for sends made through the engine API, i.e. by us. It usually
 * arrives before the send call returns, and it still arrives when that call timed out on our
 * side. Matching it to the message we were sending to that person records the engine id, so a
 * timed-out send that actually went through is marked SENT and never sent a second time.
 */
async function onSendMessage(ctx: Ctx, instance: string, data: Record<string, unknown>): Promise<void> {
  const key = (data.key ?? {}) as Record<string, unknown>;
  const keyId = typeof key.id === 'string' ? key.id : null;
  if (!keyId) return;
  const known = await ctx.db.message.findUnique({ where: { engineMessageId: keyId }, select: { id: true } });
  if (known) return;
  const account = await ctx.db.account.findUnique({ where: { instanceName: instance }, select: { id: true } });
  if (!account) return;
  const to =
    digitsFromJid(typeof key.remoteJid === 'string' ? key.remoteJid : null) ??
    digitsFromJid(typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : null);
  if (!to) return;
  const candidate = await ctx.db.message.findFirst({
    where: {
      accountId: account.id,
      toDigits: to,
      engineMessageId: null,
      status: { in: ['SENDING', 'QUEUED', 'FAILED'] },
      sendingAt: { gte: new Date(Date.now() - CORRELATE_WINDOW_MS) },
    },
    orderBy: { sendingAt: 'desc' },
    select: { id: true },
  });
  if (!candidate) return;
  await recordSent(ctx, candidate.id, keyId);
  ctx.log.debug({ messageId: candidate.id }, 'send event matched a message being sent');
}

async function onMessagesUpsert(ctx: Ctx, instance: string, data: Record<string, unknown>): Promise<void> {
  const key = (data.key ?? {}) as Record<string, unknown>;
  if (key.fromMe !== false) return;
  const msg = (data.message ?? {}) as Record<string, unknown>;
  const ext = (msg.extendedTextMessage ?? {}) as Record<string, unknown>;
  const words = typeof msg.conversation === 'string' ? msg.conversation : typeof ext.text === 'string' ? ext.text : '';
  // Only a reply that is exactly a stop word counts; the text itself is never stored or logged.
  if (!STOP_WORDS.has(words.trim().toUpperCase().replace(/[.!]+$/, ''))) return;
  const from =
    digitsFromJid(typeof key.remoteJid === 'string' ? key.remoteJid : null) ??
    digitsFromJid(typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : null) ??
    digitsFromJid(typeof key.senderPn === 'string' ? key.senderPn : null);
  if (!from) return;
  const account = await ctx.db.account.findUnique({ where: { instanceName: instance } });
  if (!account) return;
  await ctx.db.$transaction(async (tx) => {
    const created = await tx.optOut.createMany({ data: [{ accountId: account.id, toDigits: from }], skipDuplicates: true });
    if (created.count > 0) {
      await enqueueForAllModules(tx, 'contact.opted_out', {
        accountId: account.id,
        clientId: account.clientId,
        kind: account.kind,
        // The module needs the number to mark its own contact; it is sent signed, never logged.
        contact: from,
        at: new Date().toISOString(),
      });
    }
  });
  ctx.log.info({ accountId: account.id }, 'contact opted out (STOP)');
}
