import type { Account, Message } from '@prisma/client';
import type { Ctx } from '../context';
import { EngineError } from '../engine/client';
import { backoffMs, dailyCapFor, isExpired, isOverCap, istDayStart, MAX_TRIES, nextIstDayStart, randomGapMs, STALE_SENDING_MS } from '../domain/rules';
import { applyMessageStatus, recordSent } from '../messages/status-apply';
import { isOnWhatsApp } from '../numbers/service';
import { checkMediaUrl, fetchImage, ImageCache, MediaFetchError, type FetchedImage } from '../lib/media';

// Sends queued messages: one at a time per number, a human-like pause between two messages
// from the same number, a daily cap per number. Runs only in the leader instance.

const NOT_ON_WHATSAPP = 'This number is not on WhatsApp.';
const GAVE_UP = 'WhatsApp could not send this after 3 tries. Please try again later.';
const REFUSED = 'WhatsApp refused this message.';
const PICTURE = 'The picture could not be sent';

export interface SenderOptions {
  rand?: () => number;
  notReadyWaitMs?: number;
}

export class Sender {
  /** accountId -> earliest time the next message from that number may go. */
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly busy = new Map<string, Promise<void>>();
  /** Message ids being worked on right now (never treated as stale). */
  readonly inFlight = new Set<string>();
  private stopping = false;
  private capLogged = new Set<string>();
  /** One campaign picture goes to many people; it is fetched once, not once per message. */
  private readonly images = new ImageCache();

  private readonly rand: () => number;
  /** How long to wait before looking again at a number that is not connected / an engine that is down. */
  private readonly notReadyWaitMs: number;

  constructor(
    private readonly ctx: Ctx,
    opts: SenderOptions = {},
  ) {
    this.rand = opts.rand ?? Math.random;
    this.notReadyWaitMs = opts.notReadyWaitMs ?? 15_000;
  }

  /** No new work after this; in-flight sends finish. */
  stop(): void {
    this.stopping = true;
  }

  /** Resolves when every in-flight send has finished (or the timeout passed). */
  async drain(timeoutMs: number): Promise<boolean> {
    const all = Promise.all([...this.busy.values()]).then(() => true);
    const timer = new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref());
    return Promise.race([all, timer]);
  }

  /**
   * Crash safety, run when this instance becomes the sender. A message left SENDING without an
   * engine id was never confirmed sent, so after 2 minutes it goes back to the queue. One that
   * has an engine id was sent: it is marked SENT and never sent again.
   */
  async recoverStale(): Promise<{ requeued: number; confirmed: number }> {
    const cutoff = new Date(Date.now() - STALE_SENDING_MS);
    const exclude = [...this.inFlight];
    const confirmed = await this.ctx.db.message.findMany({
      where: { status: 'SENDING', engineMessageId: { not: null }, sendingAt: { lt: cutoff }, id: { notIn: exclude } },
      select: { id: true },
    });
    for (const m of confirmed) await applyMessageStatus(this.ctx, m.id, 'SENT');
    const requeued = await this.ctx.db.message.updateMany({
      where: { status: 'SENDING', engineMessageId: null, sendingAt: { lt: cutoff }, id: { notIn: exclude } },
      data: { status: 'QUEUED', nextAttemptAt: new Date() },
    });
    if (requeued.count || confirmed.length) {
      this.ctx.log.warn({ requeued: requeued.count, confirmed: confirmed.length }, 'recovered messages left mid-send');
    }
    return { requeued: requeued.count, confirmed: confirmed.length };
  }

  /** Queued messages older than 24 h are never sent late. */
  async expireOld(): Promise<number> {
    const old = await this.ctx.db.message.findMany({
      where: { status: 'QUEUED', queuedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      select: { id: true },
      take: 500,
    });
    for (const m of old) await applyMessageStatus(this.ctx, m.id, 'EXPIRED');
    return old.length;
  }

  /** One pass: start work for every number that has something due and is free. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = Date.now();
    const due = await this.ctx.db.message.groupBy({
      by: ['accountId'],
      where: { status: 'QUEUED', nextAttemptAt: { lte: new Date(now) } },
    });
    if (due.length === 0) return;
    const accounts = await this.ctx.db.account.findMany({
      where: { id: { in: due.map((d) => d.accountId) } },
    });
    for (const account of accounts) {
      if (this.stopping) return;
      if (this.busy.has(account.id)) continue;
      if ((this.nextAllowedAt.get(account.id) ?? 0) > now) continue;
      const p = this.processAccount(account)
        .catch((e) => this.ctx.log.error({ err: e, accountId: account.id }, 'sender failed for a number'))
        .finally(() => this.busy.delete(account.id));
      this.busy.set(account.id, p);
    }
  }

  /** Waits for every started piece of work (tests use this to step deterministically). */
  async idle(): Promise<void> {
    await Promise.all([...this.busy.values()]);
  }

  private pause(accountId: string, ms: number): void {
    this.nextAllowedAt.set(accountId, Date.now() + ms);
  }

  private async processAccount(account: Account): Promise<void> {
    const now = new Date();

    // Old messages expire whether or not the number is connected: they are never sent late.
    // A STOP confirmation goes before anything else waiting for this number. Somebody who has
    // just asked us to stop should not wait behind a queue of the messages they are stopping.
    const oldest =
      (await this.ctx.db.message.findFirst({
        where: { accountId: account.id, status: 'QUEUED', kind: 'STOP_OK', nextAttemptAt: { lte: now } },
        orderBy: { queuedAt: 'asc' },
      })) ??
      (await this.ctx.db.message.findFirst({
        where: { accountId: account.id, status: 'QUEUED', nextAttemptAt: { lte: now } },
        orderBy: { queuedAt: 'asc' },
      }));
    if (!oldest) return;
    if (isExpired(oldest.queuedAt, now)) {
      await applyMessageStatus(this.ctx, oldest.id, 'EXPIRED');
      return;
    }

    // Not connected: leave everything queued and look again shortly.
    if (account.status !== 'CONNECTED') {
      this.pause(account.id, this.notReadyWaitMs);
      return;
    }

    const cap = dailyCapFor(account, now, this.ctx.config.SCALEEZY_DAILY_CAP);
    const sentToday = await this.ctx.db.message.count({
      where: { accountId: account.id, sentAt: { gte: istDayStart(now) } },
    });
    // The cap exists so a number is not seen to blast messages. A STOP confirmation is the
    // opposite of that, and making somebody wait until tomorrow to hear that we stopped is how a
    // number gets reported. It is one message, and only ever one per person.
    if (oldest.kind !== 'STOP_OK' && isOverCap(sentToday, cap)) {
      // Stays queued until the next Indian day; it is never dropped.
      if (!this.capLogged.has(account.id)) {
        this.ctx.log.warn({ accountId: account.id, cap }, 'daily cap reached; messages wait for tomorrow');
        this.capLogged.add(account.id);
      }
      this.pause(account.id, Math.max(60_000, nextIstDayStart(now).getTime() - now.getTime()));
      return;
    }
    this.capLogged.delete(account.id);

    // Claim it. The status guard makes the claim safe even if two senders ever overlapped.
    const claimed = await this.ctx.db.message.updateMany({
      where: { id: oldest.id, status: 'QUEUED' },
      data: { status: 'SENDING', sendingAt: new Date() },
    });
    if (claimed.count !== 1) return;

    this.inFlight.add(oldest.id);
    try {
      await this.sendOne(account, oldest);
    } finally {
      this.inFlight.delete(oldest.id);
    }
  }

  private async sendOne(account: Account, m: Message): Promise<void> {
    const { engine } = this.ctx;
    try {
      const onWa = await isOnWhatsApp(this.ctx, account, m.toDigits);
      if (!onWa) {
        await applyMessageStatus(this.ctx, m.id, 'FAILED', { failReason: NOT_ON_WHATSAPP, failCode: 'NOT_ON_WHATSAPP' });
        return;
      }

      let result: { engineMessageId: string };
      if (m.mediaUrl) {
        const img = await this.picture(m.mediaUrl);
        result = await engine.sendImage(account.instanceName, m.toDigits, { base64: img.bytes.toString('base64'), mimeType: img.mimeType, caption: m.text });
      } else if (m.document) {
        result = await engine.sendDocument(account.instanceName, m.toDigits, {
          base64: Buffer.from(m.document).toString('base64'),
          fileName: m.fileName ?? 'document.pdf',
          mimeType: m.mimeType ?? 'application/pdf',
          caption: m.text,
        });
      } else {
        result = await engine.sendText(account.instanceName, m.toDigits, m.text ?? '', { linkPreview: m.linkPreview });
      }

      await this.recordWithRetry(m.id, result.engineMessageId);
      this.ctx.log.info({ messageId: m.id, accountId: account.id }, 'message sent');
      this.pause(account.id, randomGapMs(this.ctx.config.SEND_GAP_MIN_MS, this.ctx.config.SEND_GAP_MAX_MS, this.rand));
    } catch (e) {
      await this.handleSendError(account, m, e);
    }
  }

  /**
   * WhatsApp has the message; losing that fact would mean sending it again. A database blip is
   * retried here for up to about two minutes before giving up (and the send event from the
   * engine records it too).
   */
  private async recordWithRetry(messageId: string, engineMessageId: string): Promise<void> {
    let wait = 500;
    for (let i = 0; ; i++) {
      try {
        await recordSent(this.ctx, messageId, engineMessageId);
        return;
      } catch (e) {
        if (i >= 10) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 20_000);
      }
    }
  }

  /**
   * The picture's bytes. The address is checked again here, not only when queued: a folder taken
   * off MEDIA_URL_PREFIXES stops pictures from it even for messages already waiting.
   */
  private async picture(url: string): Promise<FetchedImage> {
    try {
      checkMediaUrl(url, this.ctx.config.mediaUrlPrefixes, this.ctx.config.NODE_ENV === 'production');
    } catch {
      throw new MediaFetchError(false, "Its address is no longer in ScaleEzy's picture storage.");
    }
    const cached = this.images.get(url);
    if (cached) return cached;
    const img = await fetchImage(url);
    this.images.set(url, img);
    return img;
  }

  private async handleSendError(account: Account, m: Message, e: unknown): Promise<void> {
    if (e instanceof MediaFetchError) {
      // Nothing reached WhatsApp: the picture is fetched before the engine is called.
      const tries = m.tries + 1;
      if (!e.transient || tries >= MAX_TRIES) {
        await this.ctx.db.message.update({ where: { id: m.id }, data: { tries } });
        await applyMessageStatus(this.ctx, m.id, 'FAILED', { failReason: `${PICTURE}: ${e.message}`, failCode: 'MEDIA_FETCH_FAILED' });
        return;
      }
      this.ctx.log.warn({ messageId: m.id, tries, reason: e.message }, 'picture could not be fetched; will retry');
      await this.ctx.db.message.updateMany({
        where: { id: m.id, status: 'SENDING' },
        data: { status: 'QUEUED', tries, nextAttemptAt: new Date(Date.now() + backoffMs(tries)) },
      });
      return;
    }
    if (!(e instanceof EngineError)) {
      // Our own failure (e.g. database). Leave the row SENDING: if the send did not happen it is
      // requeued after 2 minutes; if it did, the engine's send event records it.
      this.ctx.log.error({ err: e, messageId: m.id }, 'unexpected error while sending');
      this.pause(account.id, 30_000);
      return;
    }
    const requeue = async (opts: { countTry: boolean; waitMs: number }) => {
      const tries = m.tries + (opts.countTry ? 1 : 0);
      await this.ctx.db.message.updateMany({
        where: { id: m.id, status: 'SENDING' },
        data: { status: 'QUEUED', tries, nextAttemptAt: new Date(Date.now() + opts.waitMs) },
      });
    };

    switch (e.kind) {
      case 'not_on_whatsapp':
        await this.ctx.db.numberCheck.upsert({
          where: { toDigits: m.toDigits },
          create: { toDigits: m.toDigits, onWhatsApp: false },
          update: { onWhatsApp: false, checkedAt: new Date() },
        });
        await applyMessageStatus(this.ctx, m.id, 'FAILED', { failReason: NOT_ON_WHATSAPP, failCode: 'NOT_ON_WHATSAPP' });
        return;
      case 'unreachable':
      case 'not_connected':
      case 'not_found':
      case 'unauthorized':
        // Nothing was sent. Wait without using up a try; the 24 h expiry is the limit.
        this.ctx.log.warn({ messageId: m.id, accountId: account.id, reason: e.kind }, 'engine not ready; message stays queued');
        await requeue({ countTry: false, waitMs: this.notReadyWaitMs });
        this.pause(account.id, this.notReadyWaitMs);
        return;
      case 'timeout':
      case 'server': {
        const tries = m.tries + 1;
        if (tries >= MAX_TRIES) {
          await this.ctx.db.message.update({ where: { id: m.id }, data: { tries } });
          await applyMessageStatus(this.ctx, m.id, 'FAILED', { failReason: GAVE_UP, failCode: 'ENGINE_GAVE_UP' });
          return;
        }
        this.ctx.log.warn({ messageId: m.id, tries, reason: e.kind }, 'send failed; will retry');
        await requeue({ countTry: true, waitMs: backoffMs(tries) });
        return;
      }
      case 'bad_media':
        await applyMessageStatus(this.ctx, m.id, 'FAILED', { failReason: `${PICTURE}: WhatsApp could not read it as a picture.`, failCode: 'MEDIA_UNREADABLE' });
        return;
      case 'rejected':
      default:
        await applyMessageStatus(this.ctx, m.id, 'FAILED', { failReason: REFUSED, failCode: 'ENGINE_REJECTED' });
        return;
    }
  }
}
