import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { Account, ModuleClient } from '@prisma/client';
import { hasTestDb, listen, makeEnv, queueMessage, resetDb, seedClient, seedModule, seedScaleezy, sleep, type TestEnv } from '../helpers/setup';
import { JPEG, MediaServer, PNG } from '../helpers/media-server';
import { Sender } from '../../src/worker/sender';
import { applyMessageStatus } from '../../src/messages/status-apply';
import { contentHash } from '../../src/domain/rules';

// Pictures, link cards and failure codes, end to end: the real API and worker, the real test
// database, a fake engine and a fake picture storage that misbehave on purpose.

describe.skipIf(!hasTestDb)('pictures and link cards', () => {
  const media = new MediaServer();
  let env: TestEnv;
  let base: string;
  let server: Server;
  let shop: Account;
  let inventory: Awaited<ReturnType<typeof seedModule>>;
  let mod: ModuleClient;
  let sender: Sender;

  beforeAll(async () => {
    await media.start();
    env = await makeEnv({ config: { MEDIA_URL_PREFIXES: media.prefix } });
    ({ url: base, server } = await listen(env.app));
  });
  afterAll(async () => {
    server.close();
    await env.close();
    await media.stop();
  });
  beforeEach(async () => {
    await resetDb(env.db);
    media.reset();
    env.engine.sends.length = 0;
    env.engine.nextSends.length = 0;
    env.engine.notOnWhatsApp.clear();
    await seedScaleezy(env);
    shop = await seedClient(env, 'shop1');
    // A webhook address so status events are queued (nothing dispatches them in these tests).
    inventory = await seedModule(env, 'inventory', { canSendAsScaleEzy: true, webhookUrl: 'http://127.0.0.1:1/hook' });
    mod = inventory.mod;
    sender = new Sender(env.ctx, { notReadyWaitMs: 50 });
  });

  const post = (path: string, body: unknown, key = inventory.key) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-module-key': key }, body: JSON.stringify(body) });
  const msg = (over: Record<string, unknown> = {}) => ({
    from: { clientId: 'shop1' },
    to: '9876543210',
    text: '🎉 Diwali offer – Red Kanchipuram silk saree, 20% off.',
    kind: 'C8',
    idempotencyKey: `idem-${Math.random()}`,
    ...over,
  });
  const errorOf = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
  const step = async (s = sender) => {
    await sleep(30);
    await s.tick();
    await s.idle();
  };
  const row = (id: string) => env.db.message.findUniqueOrThrow({ where: { id } });
  const queuePicture = (url: string, over: Record<string, unknown> = {}) =>
    queueMessage(env, shop.id, mod.id, { kind: 'C8', mediaUrl: url, mediaType: 'IMAGE', text: 'Diwali offer', ...over });

  // ── API ────────────────────────────────────────────────────────────────────────────────

  it('queues a picture with its words, and says so', async () => {
    const url = media.put('saree.jpg', { kind: 'file', body: JPEG });
    const r = await post('/v1/messages', msg({ image: { url } }));
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };
    const m = await row(id);
    expect(m.mediaUrl).toBe(url);
    expect(m.mediaType).toBe('IMAGE');
    expect(m.document).toBeNull();
    expect(m.linkPreview).toBe(false);
    expect(m.contentHash).toBe(contentHash(m.text, null, url));
    // Nothing is fetched until the message is due.
    expect(media.hitsFor('saree.jpg')).toBe(0);
  });

  it('a picture alone, with no words, is allowed', async () => {
    const r = await post('/v1/messages', msg({ text: null, image: { url: media.url('a.jpg') } }));
    expect(r.status).toBe(202);
  });

  it('refuses pictures from anywhere else, and mixed or oversized messages, in plain words', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ image: { url: 'https://evil.example.com/whatsapp-media/a.jpg' } }, /https|picture storage/],
      [{ image: { url: `${media.base}/other/a.jpg` } }, /picture storage/],
      [{ image: { url: `${media.prefix}a.jpg?x=1` } }, /\?/],
      [{ image: { url: `${media.prefix}..%2Fx.jpg` } }, /not allowed/],
      [{ image: { url: media.url('a.jpg') }, document: { fileName: 'a.pdf', mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64') } }, /not both/],
      [{ image: { url: media.url('a.jpg') }, text: 'x'.repeat(1025) }, /1,024 characters\. These are 1,025/],
      [{ image: { url: media.url('a.jpg') }, linkPreview: true }, /link card/],
      [{ text: null, image: null }, /nothing to send/],
      [{ image: { url: media.url('a.jpg'), extra: 1 } }, /unknown field/],
    ];
    for (const [over, expected] of cases) {
      const r = await post('/v1/messages', msg(over));
      expect(r.status, JSON.stringify(over).slice(0, 80)).toBe(400);
      expect(await errorOf(r)).toMatch(expected);
    }
    expect(await env.db.message.count()).toBe(0);
  });

  it('exactly 1,024 characters under a picture is fine; a text message may still be longer', async () => {
    expect((await post('/v1/messages', msg({ image: { url: media.url('a.jpg') }, text: 'x'.repeat(1024) }))).status).toBe(202);
    expect((await post('/v1/messages', msg({ text: 'y'.repeat(3000) }))).status).toBe(202);
  });

  it('same words and same picture within 60 s is the same message; another picture is a new one', async () => {
    const a = await post('/v1/messages', msg({ image: { url: media.url('a.jpg') }, idempotencyKey: 'k1' }));
    const again = await post('/v1/messages', msg({ image: { url: media.url('a.jpg') }, idempotencyKey: 'k2' }));
    const other = await post('/v1/messages', msg({ image: { url: media.url('b.jpg') }, idempotencyKey: 'k3' }));
    const first = (await a.json()) as { id: string };
    const second = (await again.json()) as { id: string; duplicate?: boolean };
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    expect(((await other.json()) as { id: string }).id).not.toBe(first.id);
    expect(await env.db.message.count()).toBe(2);
  });

  it('a link card can be asked for on a text message', async () => {
    const r = await post('/v1/messages', msg({ text: 'Shop now: https://go.scaleezy.com/x7Kq9Pm', linkPreview: true }));
    expect(r.status).toBe(202);
    expect((await row(((await r.json()) as { id: string }).id)).linkPreview).toBe(true);
  });

  it('capabilities: module key only; says pictures are on, with the limits and the allowed folder', async () => {
    const noKey = await fetch(`${base}/v1/capabilities`);
    expect(noKey.status).toBe(401);
    const r = await fetch(`${base}/v1/capabilities`, { headers: { 'x-module-key': inventory.key } });
    expect(r.status).toBe(200);
    const c = (await r.json()) as Record<string, any>;
    expect(c.image).toEqual({ mimeTypes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024, maxCaption: 1024, urlPrefixes: [media.prefix] });
    expect(c.linkPreview).toBe(true);
    expect(c.failCodes).toContain('MEDIA_FETCH_FAILED');
  });

  it('with no picture folder set up: capabilities say no pictures, and a picture is refused', async () => {
    const bare = await makeEnv();
    const { url, server: s } = await listen(bare.app);
    try {
      // Same test database: shop1 is already there from beforeEach.
      const k = await seedModule(bare, 'other');
      const c = (await (await fetch(`${url}/v1/capabilities`, { headers: { 'x-module-key': k.key } })).json()) as Record<string, unknown>;
      expect(c.image).toBe(false);
      expect(c.linkPreview).toBe(true);
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-module-key': k.key },
        body: JSON.stringify(msg({ image: { url: 'https://store.supabase.co/storage/v1/object/public/whatsapp-media/a.jpg' } })),
      });
      expect(r.status).toBe(400);
      expect(await errorOf(r)).toMatch(/no picture storage set up/);
    } finally {
      s.close();
      await bare.close();
    }
  });

  it('the database itself refuses a picture without its type, and a picture with a PDF', async () => {
    await expect(queueMessage(env, shop.id, mod.id, { mediaUrl: media.url('a.jpg') })).rejects.toThrow(/Message_media_pair/);
    await expect(
      queueMessage(env, shop.id, mod.id, { mediaUrl: media.url('a.jpg'), mediaType: 'IMAGE', document: new Uint8Array(Buffer.from('%PDF-1.4')) }),
    ).rejects.toThrow(/Message_media_or_document/);
  });

  // ── Worker ─────────────────────────────────────────────────────────────────────────────

  it('sends the picture with its words as the caption, as the real bytes', async () => {
    const m = await queuePicture(media.put('saree.jpg', { kind: 'file', body: JPEG }));
    await step();
    expect((await row(m.id)).status).toBe('SENT');
    expect(env.engine.sends).toHaveLength(1);
    const s = env.engine.sends[0]!;
    expect(s.type).toBe('image');
    expect(s.mimeType).toBe('image/jpeg');
    expect(s.fileName).toBe('picture.jpg');
    expect(s.caption).toBe('Diwali offer');
    expect(s.mediaBytes).toBe(JPEG.length);
    expect(s.mediaHead).toBe(JPEG.subarray(0, 8).toString('hex'));
  });

  it('a PNG goes as a PNG; a picture with no words goes without a caption', async () => {
    const m = await queuePicture(media.put('logo.png', { kind: 'file', body: PNG }), { text: null });
    await step();
    expect((await row(m.id)).status).toBe('SENT');
    expect(env.engine.sends[0]).toMatchObject({ type: 'image', mimeType: 'image/png', fileName: 'picture.png' });
    expect(env.engine.sends[0]!.caption).toBeUndefined();
  });

  it('one picture to many people is fetched once', async () => {
    const url = media.put('offer.jpg', { kind: 'file', body: JPEG });
    const ids = [];
    for (const to of ['919800000001', '919800000002', '919800000003']) ids.push((await queuePicture(url, { toDigits: to })).id);
    for (let i = 0; i < 3; i++) await step();
    for (const id of ids) expect((await row(id)).status).toBe('SENT');
    expect(env.engine.sends.filter((s) => s.type === 'image')).toHaveLength(3);
    expect(media.hitsFor('offer.jpg')).toBe(1);
  });

  it('picture gone from storage: fails at once as MEDIA_FETCH_FAILED, nothing reaches WhatsApp, the module is told why', async () => {
    const m = await queuePicture(media.url('deleted.jpg'));
    await step();
    const r = await row(m.id);
    expect(r.status).toBe('FAILED');
    expect(r.failCode).toBe('MEDIA_FETCH_FAILED');
    expect(r.failReason).toBe('The picture could not be sent: The picture is no longer in picture storage.');
    expect(env.engine.sends).toHaveLength(0);
    const events = await env.db.moduleEvent.findMany({ where: { type: 'message.status' } });
    const last = events.map((e) => e.payload as Record<string, unknown>).find((p) => p.messageId === m.id && p.status === 'FAILED');
    expect(last).toMatchObject({ failCode: 'MEDIA_FETCH_FAILED', failReason: r.failReason });
  });

  it('not a picture (a web page saved as .jpg): fails for good, never sent as something else', async () => {
    const m = await queuePicture(media.put('page.jpg', { kind: 'file', body: Buffer.from('<html>sign in</html>') }));
    await step();
    expect(await row(m.id)).toMatchObject({ status: 'FAILED', failCode: 'MEDIA_FETCH_FAILED' });
    expect(env.engine.sends).toHaveLength(0);
  });

  it('storage down: retried with a wait, no WhatsApp send; goes once storage is back', async () => {
    media.put('flaky.jpg', { kind: 'file', body: JPEG });
    media.queue('flaky.jpg', { kind: 'status', status: 503 });
    const m = await queuePicture(media.url('flaky.jpg'));
    await step();
    let r = await row(m.id);
    expect(r.status).toBe('QUEUED');
    expect(r.tries).toBe(1);
    expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(env.engine.sends).toHaveLength(0);
    await env.db.message.update({ where: { id: m.id }, data: { nextAttemptAt: new Date() } });
    await step();
    r = await row(m.id);
    expect(r.status).toBe('SENT');
    expect(r.failCode).toBeNull();
    expect(env.engine.sends).toHaveLength(1);
  });

  it('storage down three times: MEDIA_FETCH_FAILED after the third try', async () => {
    media.put('down.jpg', { kind: 'status', status: 500 });
    const m = await queuePicture(media.url('down.jpg'));
    for (let i = 0; i < 3; i++) {
      await env.db.message.update({ where: { id: m.id }, data: { nextAttemptAt: new Date() } });
      await step();
    }
    const r = await row(m.id);
    expect(r).toMatchObject({ status: 'FAILED', failCode: 'MEDIA_FETCH_FAILED', tries: 3 });
    expect(r.failReason).toMatch(/Picture storage failed \(500\)/);
    expect(env.engine.sends).toHaveLength(0);
  });

  it('a folder taken off the list stops pictures already waiting', async () => {
    const m = await queuePicture(media.put('a.jpg', { kind: 'file', body: JPEG }));
    const strict = new Sender({ ...env.ctx, config: { ...env.ctx.config, mediaUrlPrefixes: ['https://store.supabase.co/storage/v1/object/public/whatsapp-media/'] } }, { notReadyWaitMs: 50 });
    await step(strict);
    expect(await row(m.id)).toMatchObject({ status: 'FAILED', failCode: 'MEDIA_FETCH_FAILED' });
    expect(media.hitsFor('a.jpg')).toBe(0);
    expect(env.engine.sends).toHaveLength(0);
  });

  it('WhatsApp refuses the picture: ENGINE_REJECTED, not retried', async () => {
    env.engine.nextSends.push({ kind: 'status', status: 400, message: 'Invalid media' });
    const m = await queuePicture(media.put('a.jpg', { kind: 'file', body: JPEG }));
    await step();
    expect(await row(m.id)).toMatchObject({ status: 'FAILED', failCode: 'ENGINE_REJECTED' });
  });

  it('a picture the engine cannot read (its real answer): MEDIA_UNREADABLE at once, not three engine retries', async () => {
    env.engine.nextSends.push({ kind: 'status', status: 500, message: 'Error: Input buffer has corrupt header: VipsJpeg: Corrupt JPEG data' });
    const m = await queuePicture(media.put('broken.jpg', { kind: 'file', body: JPEG }));
    await step();
    const r = await row(m.id);
    expect(r).toMatchObject({ status: 'FAILED', failCode: 'MEDIA_UNREADABLE', tries: 0 });
    expect(r.failReason).toBe('The picture could not be sent: WhatsApp could not read it as a picture.');
  });

  it('engine has no live socket (its real answer): waits without using a try, then sends', async () => {
    env.engine.nextSends.push({ kind: 'status', status: 500, message: "TypeError: Cannot read properties of undefined (reading 'waUploadToServer')" });
    const m = await queuePicture(media.put('a.jpg', { kind: 'file', body: JPEG }));
    await step();
    expect(await row(m.id)).toMatchObject({ status: 'QUEUED', tries: 0 });
    await env.db.message.update({ where: { id: m.id }, data: { nextAttemptAt: new Date() } });
    await sleep(60);
    await step();
    expect((await row(m.id)).status).toBe('SENT');
  });

  it('link card: on only when asked for; off for every other text', async () => {
    const on = await queueMessage(env, shop.id, mod.id, { text: 'https://go.scaleezy.com/x7Kq9Pm', linkPreview: true, toDigits: '919800000001' });
    const off = await queueMessage(env, shop.id, mod.id, { text: 'Your bill is ready', toDigits: '919800000002' });
    await step();
    await step();
    expect((await row(on.id)).status).toBe('SENT');
    expect((await row(off.id)).status).toBe('SENT');
    const byNumber = Object.fromEntries(env.engine.sends.map((s) => [s.number, s]));
    expect(byNumber['919800000001']).toMatchObject({ type: 'text', linkPreview: true });
    expect(byNumber['919800000002']).toMatchObject({ type: 'text', linkPreview: false });
  });

  // ── Failure codes ──────────────────────────────────────────────────────────────────────

  it('every failure carries a code: not on WhatsApp, engine gave up, expired', async () => {
    env.engine.notOnWhatsApp.add('919811111111');
    const noWa = await queueMessage(env, shop.id, mod.id, { toDigits: '919811111111' });
    await step();
    expect(await row(noWa.id)).toMatchObject({ status: 'FAILED', failCode: 'NOT_ON_WHATSAPP' });

    env.engine.nextSends.push({ kind: 'status', status: 500 }, { kind: 'status', status: 500 }, { kind: 'status', status: 500 });
    const flaky = await queueMessage(env, shop.id, mod.id, { toDigits: '919822222222' });
    for (let i = 0; i < 3; i++) {
      await env.db.message.update({ where: { id: flaky.id }, data: { nextAttemptAt: new Date() } });
      await step();
    }
    expect(await row(flaky.id)).toMatchObject({ status: 'FAILED', failCode: 'ENGINE_GAVE_UP' });

    const old = await queueMessage(env, shop.id, mod.id, { toDigits: '919833333333', queuedAt: new Date(Date.now() - 25 * 3600_000) });
    await sender.expireOld();
    expect(await row(old.id)).toMatchObject({ status: 'EXPIRED', failCode: 'EXPIRED' });
  });

  it('WhatsApp says it failed, then a delivered tick arrives: the code is cleared with the words', async () => {
    const m = await queueMessage(env, shop.id, mod.id);
    await step();
    await applyMessageStatus(env.ctx, m.id, 'FAILED');
    expect(await row(m.id)).toMatchObject({ status: 'FAILED', failCode: 'DELIVERY_FAILED' });
    await applyMessageStatus(env.ctx, m.id, 'DELIVERED');
    expect(await row(m.id)).toMatchObject({ status: 'DELIVERED', failCode: null, failReason: null });
  });

  it('GET /v1/messages/:id shows the failure code', async () => {
    const m = await queuePicture(media.url('missing.jpg'));
    await step();
    const r = await fetch(`${base}/v1/messages/${m.id}`, { headers: { 'x-module-key': inventory.key } });
    expect(((await r.json()) as Record<string, unknown>).failCode).toBe('MEDIA_FETCH_FAILED');
  });
});
