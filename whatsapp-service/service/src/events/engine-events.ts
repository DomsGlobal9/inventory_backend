import type { Ctx } from '../context';
import { mapConnectionState, mapEngineMessageStatus, advanceStatus } from '../domain/status';
import { digitsFromJid } from '../lib/phone';
import { applyMessageStatus, recordSent } from '../messages/status-apply';
import { setAccountStatus } from '../accounts/service';
import { enqueueForAllModules, enqueueForMessageReaders } from './module-events';
import { checkInCode } from '../domain/checkin';

// Events pushed by the engine (Evolution's global webhook). Each handler is idempotent: the
// engine may send an event twice or out of order, and the health watch may already have
// recorded the same change.

export interface EnginePayload {
  event?: string;
  instance?: string;
  data?: unknown;
}

const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'STOP ALL']);

/**
 * The one message allowed to somebody who has just asked us to stop.
 *
 * Silence reads as "it did not work": the person replies STOP again, or blocks the shop's number
 * and reports it -- which is exactly the damage the slow sending rate exists to prevent. So we say
 * once that we heard them, and nothing after that.
 *
 * The shop is not named. The service does not know shop names (it holds a client id, and
 * displayName is usually empty), and the message lands inside the shop's own chat, so the person
 * can already see whose number it is. Nothing here suggests it can be undone, because it cannot.
 */
const stopConfirmation = (shop: string | null) =>
  `You will not get any more offers from ${shop?.trim() || 'this shop'}. Your bills and order updates have stopped too.`;
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
    // A number being linked afresh has no link to lose. The 401 is the engine finishing with the
    // old instance (removed at the start of the re-link) and can arrive late; recording it would
    // make the next QR poll wipe the new instance, and the QR would never settle.
    if (account.status === 'LINKING' && account.linkedAt === null) return;
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
      await applyMessageStatus(ctx, msg.id, status, status === 'FAILED' ? { failReason: 'WhatsApp could not deliver this message.' } : { engineConfirmed: true });
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
  if (known) {
    await confirmedByEngine(ctx, keyId);
    return;
  }
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
  await confirmedByEngine(ctx, keyId);
  ctx.log.debug({ messageId: candidate.id }, 'send event matched a message being sent');
}

/** The engine's own event about one of our messages arrived: the event path works for it. */
async function confirmedByEngine(ctx: Ctx, engineMessageId: string): Promise<void> {
  await ctx.db.message.updateMany({ where: { engineMessageId, engineConfirmedAt: null }, data: { engineConfirmedAt: new Date() } });
}

async function onMessagesUpsert(ctx: Ctx, instance: string, data: Record<string, unknown>): Promise<void> {
  const key = (data.key ?? {}) as Record<string, unknown>;
  if (key.fromMe !== false) return;
  const msg = (data.message ?? {}) as Record<string, unknown>;
  const ext = (msg.extendedTextMessage ?? {}) as Record<string, unknown>;
  const words = typeof msg.conversation === 'string' ? msg.conversation : typeof ext.text === 'string' ? ext.text : '';
  const doorCode = checkInCode(words);
  // Only a reply that is exactly a stop word, or one carrying a door code, counts here; the text itself
  // is never stored or logged. Any other message goes to the modules that follow up leads (CRM).
  if (!doorCode && !STOP_WORDS.has(words.trim().toUpperCase().replace(/[.!]+$/, ''))) return onCustomerMessage(ctx, instance, data);
  const from =
    digitsFromJid(typeof key.remoteJid === 'string' ? key.remoteJid : null) ??
    digitsFromJid(typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : null) ??
    digitsFromJid(typeof key.senderPn === 'string' ? key.senderPn : null);
  if (!from) return;
  const account = await ctx.db.account.findUnique({ where: { instanceName: instance } });
  if (!account) return;
  if (doorCode) {
    // A customer at a shop's door. Only a shop's own number has a door; the shop's module decides
    // which store the code names and what to show its staff.
    if (account.kind !== 'CLIENT') return;
    await ctx.db.$transaction((tx) => enqueueForAllModules(tx, 'contact.checked_in', {
      accountId: account.id, clientId: account.clientId, kind: account.kind,
      contact: from, code: doorCode, at: new Date().toISOString(),
    }));
    ctx.log.info({ accountId: account.id }, 'customer checked in at the door');
    return;
  }
  await ctx.db.$transaction(async (tx) => {
    const created = await tx.optOut.createMany({ data: [{ accountId: account.id, toDigits: from }], skipDuplicates: true });
    if (created.count > 0) {
      // Queued here, not through queueMessage: that path refuses anything for a number which has
      // opted out, which is the rule that makes "not even a bill" true. This is its one exception,
      // and `created.count > 0` keeps it to the first STOP -- replying STOP twice sends nothing.
      await tx.message.create({
        data: {
          accountId: account.id,
          moduleId: null,
          toDigits: from,
          kind: 'STOP_OK',
          idempotencyKey: `stop-ok:${account.id}:${from}`,
          contentHash: `stop-ok:${account.id}:${from}`,
          text: stopConfirmation(account.displayName),
        },
      });
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

const MAX_TEXT = 4096;
const MEDIA: Record<string, 'image' | 'video' | 'audio' | 'document' | 'sticker'> = {
  imageMessage: 'image', videoMessage: 'video', ptvMessage: 'video', audioMessage: 'audio',
  documentMessage: 'document', documentWithCaptionMessage: 'document', stickerMessage: 'sticker',
};

/** The message inside WhatsApp's wrappers (disappearing, view-once, ...), at most a few levels deep. */
function unwrap(msg: Record<string, unknown>): Record<string, unknown> {
  let m = msg;
  for (let i = 0; i < 4; i++) {
    const inner = (['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage']
      .map((k) => (m[k] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)
      .find((x) => x && typeof x === 'object'));
    if (!inner) break;
    m = inner;
  }
  return m;
}

/** Seconds since 1970 as the engine sends them (a number, a string, or a {low, high} long), as an ISO time. */
function whenSent(raw: unknown): string {
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' ? Number(raw)
    : raw && typeof raw === 'object' && typeof (raw as { low?: unknown }).low === 'number' ? (raw as { low: number }).low >>> 0
    : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

/**
 * A customer's own message to a shop's number (25 Nov 2026, the owner: WhatsApp messages to a shop become leads in
 * CRM). Only a shop's own (CLIENT) number; never our own messages, group chats, status updates, broadcasts or
 * reactions; only a message with words or a picture, video, voice note, document or sticker in it.
 *
 * It goes ONLY to the modules that asked for customers' messages (receivesMessages: CRM). Like a STOP, the words are
 * never stored or logged here: they ride in the signed event, are delivered, and are gone.
 */
async function onCustomerMessage(ctx: Ctx, instance: string, data: Record<string, unknown>): Promise<void> {
  const key = (data.key ?? {}) as Record<string, unknown>;
  const jid = typeof key.remoteJid === 'string' ? key.remoteJid : '';
  if (/@g\.us$|@broadcast$|@newsletter$/.test(jid) || jid === 'status@broadcast') return;
  const raw = (data.message ?? {}) as Record<string, unknown>;
  const msg = unwrap(raw);
  if (msg.reactionMessage || raw.reactionMessage || msg.protocolMessage || raw.protocolMessage) return;
  const mediaKey = Object.keys(MEDIA).find((k) => msg[k] && typeof msg[k] === 'object');
  const media = mediaKey ? { type: MEDIA[mediaKey]! } : null;
  const ext = (msg.extendedTextMessage ?? {}) as Record<string, unknown>;
  const caption = mediaKey ? (msg[mediaKey] as Record<string, unknown>).caption : undefined;
  const textRaw = typeof msg.conversation === 'string' ? msg.conversation
    : typeof ext.text === 'string' ? ext.text
    : typeof caption === 'string' ? caption : null;
  const text = textRaw && textRaw.trim() ? textRaw.slice(0, MAX_TEXT) : null;
  if (!text && !media) return;
  const messageId = typeof key.id === 'string' ? key.id : null;
  if (!messageId) return;
  const from =
    digitsFromJid(jid || null) ??
    digitsFromJid(typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : null) ??
    digitsFromJid(typeof key.senderPn === 'string' ? key.senderPn : null);
  if (!from) return;
  const account = await ctx.db.account.findUnique({ where: { instanceName: instance } });
  if (!account || account.kind !== 'CLIENT') return;
  const sent = await ctx.db.$transaction((tx) => enqueueForMessageReaders(tx, {
    accountId: account.id, clientId: account.clientId, kind: account.kind,
    contact: from, messageId, text, media,
    pushName: typeof data.pushName === 'string' && data.pushName.trim() ? data.pushName.trim().slice(0, 100) : null,
    at: whenSent(data.messageTimestamp),
  }));
  // Never the words, the number or the name: only that one arrived.
  if (sent) ctx.log.info({ accountId: account.id, media: media?.type ?? null }, 'customer message passed on');
}
