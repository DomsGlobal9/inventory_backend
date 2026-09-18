import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { hasTestDb, listen, makeEnv, resetDb, seedClient, seedModule, seedScaleezy, type TestEnv } from '../helpers/setup';

// The HTTP API end to end (real Express app, real database, fake engine).

describe.skipIf(!hasTestDb)('API', () => {
  let env: TestEnv;
  let base: string;
  let server: Server;
  let inventory: Awaited<ReturnType<typeof seedModule>>;
  let crm: Awaited<ReturnType<typeof seedModule>>;

  beforeAll(async () => {
    env = await makeEnv();
    ({ url: base, server } = await listen(env.app));
  });
  afterAll(async () => {
    server.close();
    await env.close();
  });
  beforeEach(async () => {
    await resetDb(env.db);
    await seedScaleezy(env);
    await seedClient(env, 'shop1');
    inventory = await seedModule(env, 'inventory', { canSendAsScaleEzy: true });
    crm = await seedModule(env, 'crm', { canSendAsScaleEzy: false });
  });

  const post = (path: string, body: unknown, key?: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-module-key': key } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { headers });

  const pdfB64 = Buffer.from('%PDF-1.4\n% test\n').toString('base64');
  const msg = (over: Record<string, unknown> = {}) => ({
    from: { clientId: 'shop1' },
    to: '9876543210',
    text: 'PO attached',
    kind: 'C1',
    idempotencyKey: `idem-${Math.random()}`,
    ...over,
  });

  it('wrong or missing keys get 401 with a plain message', async () => {
    for (const key of [undefined, 'wsk_wrong', 'x'.repeat(500)]) {
      const r = await post('/v1/messages', msg(), key);
      expect(r.status).toBe(401);
      expect((await r.json() as any).error.message).toBe('This key is not valid for the WhatsApp service.');
    }
    expect((await get('/admin/accounts', {})).status).toBe(401);
    expect((await get('/admin/accounts', { 'x-admin-key': 'nope' })).status).toBe(401);
    expect((await get('/admin/accounts', { 'x-admin-key': env.ctx.config.ADMIN_KEY })).status).toBe(200);
    // A module key is not an admin key.
    expect((await get('/admin/accounts', { 'x-admin-key': inventory.key })).status).toBe(401);
    // Engine webhook with a wrong secret.
    expect((await post('/engine/events/not-the-secret', { event: 'connection.update' })).status).toBe(401);
  });

  it('an inactive module is refused', async () => {
    await env.db.moduleClient.update({ where: { id: crm.mod.id }, data: { active: false } });
    expect((await post('/v1/messages', msg(), crm.key)).status).toBe(401);
  });

  it('queues a message and returns 202 with its id', async () => {
    const r = await post('/v1/messages', msg(), inventory.key);
    expect(r.status).toBe(202);
    const body = await r.json() as any;
    expect(body.status).toBe('QUEUED');
    const row = await env.db.message.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.toDigits).toBe('919876543210');
  });

  it('the same idempotency key returns the same message, never a second one', async () => {
    const m = msg({ idempotencyKey: 'po-77-send-1' });
    const a = await (await post('/v1/messages', m, inventory.key)).json() as any;
    const b = await (await post('/v1/messages', { ...m, text: 'different text' }, inventory.key)).json() as any;
    expect(b.id).toBe(a.id);
    expect(b.duplicate).toBe(true);
    // Concurrent retries: still exactly one row.
    const m2 = msg({ idempotencyKey: 'po-78-send-1', text: 'PO 78 attached' });
    const all = await Promise.all(Array.from({ length: 5 }, () => post('/v1/messages', m2, inventory.key).then((r) => r.json() as any)));
    expect(new Set(all.map((x) => x.id)).size).toBe(1);
    expect(await env.db.message.count({ where: { idempotencyKey: 'po-78-send-1' } })).toBe(1);
    // Keys are per module: another module may use the same key.
    await env.db.moduleClient.update({ where: { id: crm.mod.id }, data: { canSendAsScaleEzy: true } });
    const c = await (await post('/v1/messages', msg({ idempotencyKey: 'po-77-send-1', from: 'scaleezy', kind: 'S2' }), crm.key)).json() as any;
    expect(c.id).not.toBe(a.id);
  });

  it('the same document to the same person within 60 s returns the earlier message', async () => {
    const doc = { fileName: 'PO-77.pdf', mimeType: 'application/pdf', base64: pdfB64 };
    const a = await (await post('/v1/messages', msg({ document: doc }), inventory.key)).json() as any;
    const b = await (await post('/v1/messages', msg({ document: doc }), inventory.key)).json() as any;
    expect(b.id).toBe(a.id);
    // A different person, or a different document, is a new message.
    const c = await (await post('/v1/messages', msg({ document: doc, to: '9876500000' }), inventory.key)).json() as any;
    expect(c.id).not.toBe(a.id);
    // Older than a minute: allowed again.
    await env.db.message.update({ where: { id: a.id }, data: { queuedAt: new Date(Date.now() - 61_000) } });
    const d = await (await post('/v1/messages', msg({ document: doc }), inventory.key)).json() as any;
    expect(d.id).not.toBe(a.id);
  });

  it('refusals are plain English 4xx', async () => {
    const cases: Array<[Record<string, unknown>, number, RegExp]> = [
      [{ to: '12345' }, 400, /not a valid phone number/],
      [{ text: '', document: undefined }, 400, /nothing to send/],
      [{ document: { fileName: 'x.pdf', mimeType: 'application/pdf', base64: Buffer.from('GIF89a').toString('base64') } }, 400, /not a PDF/],
      [{ document: { fileName: 'x.png', mimeType: 'image/png', base64: pdfB64 } }, 400, /Only PDF/],
      [{ from: { clientId: 'no-such-shop' } }, 409, /not linked\. Link it in Settings → WhatsApp\./],
      [{ kind: 'Z9' }, 400, /The request is not valid/],
      [{ unexpected: true }, 400, /unknown field/],
    ];
    for (const [over, status, re] of cases) {
      const r = await post('/v1/messages', msg(over), inventory.key);
      const body = await r.json() as any;
      expect(r.status, JSON.stringify(over)).toBe(status);
      expect(body.error.message).toMatch(re);
      expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:|at .*\.js:|stack/i);
    }
  });

  it('a PDF over 5 MB is refused', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
    const r = await post('/v1/messages', msg({ document: { fileName: 'big.pdf', mimeType: 'application/pdf', base64: big } }), inventory.key);
    expect(r.status).toBe(413);
    expect((await r.json() as any).error.message).toMatch(/larger than 5 MB/);
  });

  it('a disconnected shop number is refused with how to fix it', async () => {
    await seedClient(env, 'shop2', 'DISCONNECTED', '919000000003');
    const r = await post('/v1/messages', msg({ from: { clientId: 'shop2' } }), inventory.key);
    expect(r.status).toBe(409);
    expect((await r.json() as any).error.message).toMatch(/disconnected\. Reconnect it in Settings → WhatsApp/);
  });

  it('a module without canSendAsScaleEzy cannot send from the ScaleEzy number', async () => {
    const r = await post('/v1/messages', msg({ from: 'scaleezy', kind: 'S1' }), crm.key);
    expect(r.status).toBe(403);
    expect((await r.json() as any).error.message).toBe('This module is not allowed to send from the ScaleEzy number.');
    const ok = await post('/v1/messages', msg({ from: 'scaleezy', kind: 'S1' }), inventory.key);
    expect(ok.status).toBe(202);
  });

  it('a person who replied STOP is not messaged', async () => {
    const acc = await env.db.account.findUniqueOrThrow({ where: { clientId: 'shop1' } });
    await env.db.optOut.create({ data: { accountId: acc.id, toDigits: '919876543210' } });
    const r = await post('/v1/messages', msg(), inventory.key);
    expect(r.status).toBe(403);
    expect((await r.json() as any).error.message).toMatch(/replied STOP/);
  });

  it('a module can only read its own messages', async () => {
    await env.db.moduleClient.update({ where: { id: crm.mod.id }, data: { canSendAsScaleEzy: true } });
    const a = await (await post('/v1/messages', msg(), inventory.key)).json() as any;
    const mine = await get(`/v1/messages/${a.id}`, { 'x-module-key': inventory.key });
    expect(mine.status).toBe(200);
    expect((await mine.json() as any).status).toBe('QUEUED');
    const theirs = await get(`/v1/messages/${a.id}`, { 'x-module-key': crm.key });
    expect(theirs.status).toBe(404);
  });

  it('bad JSON and unknown routes get plain JSON errors', async () => {
    const r = await post('/v1/messages', '{not json', inventory.key);
    expect(r.status).toBe(400);
    expect((await r.json() as any).error.message).toBe('The request body is not valid JSON.');
    const nf = await get('/nope', {});
    expect(nf.status).toBe(404);
    expect((await nf.json() as any).error.code).toBe('not_found');
  });

  it('account status shows a masked phone only', async () => {
    const r = await get('/v1/accounts/client/shop1', { 'x-module-key': inventory.key });
    const body = await r.json() as any;
    expect(body.status).toBe('CONNECTED');
    expect(body.phone).toBe('********0002');
    const none = await (await get('/v1/accounts/client/unknown-shop', { 'x-module-key': inventory.key })).json() as any;
    expect(none.status).toBe('NOT_LINKED');
  });

  it('link returns a QR, or a pairing code for a phone number; disconnect logs out', async () => {
    const qr = await (await post('/v1/accounts/client/shop9/link', { method: 'qr' }, inventory.key)).json() as any;
    expect(qr.status).toBe('LINKING');
    expect(qr.qr).toMatch(/^data:image\/png;base64,/);
    const code = await (await post('/v1/accounts/client/shop9/link', { method: 'code', phone: '9876543210' }, inventory.key)).json() as any;
    expect(code.pairingCode).toBe('ABCD1234');
    const noPhone = await post('/v1/accounts/client/shop9/link', { method: 'code' }, inventory.key);
    expect(noPhone.status).toBe(400);
    const d = await (await post('/v1/accounts/client/shop1/disconnect', {}, inventory.key)).json() as any;
    expect(d.status).toBe('LOGGED_OUT');
    // A connected number is never re-linked by a link call.
    await seedClient(env, 'shop3', 'CONNECTED', '919000000004');
    const again = await (await post('/v1/accounts/client/shop3/link', { method: 'qr' }, inventory.key)).json() as any;
    expect(again).toEqual({ status: 'CONNECTED' });
  });

  it('numbers/check answers from the engine and caches', async () => {
    env.engine.notOnWhatsApp.add('919876500001');
    const a = await (await post('/v1/numbers/check', { from: { clientId: 'shop1' }, to: '9876500001' }, inventory.key)).json() as any;
    expect(a).toEqual({ onWhatsApp: false });
    const b = await (await post('/v1/numbers/check', { from: { clientId: 'shop1' }, to: '9876500002' }, inventory.key)).json() as any;
    expect(b).toEqual({ onWhatsApp: true });
    const calls = env.engine.calls.filter((c) => c.includes('whatsappNumbers')).length;
    await post('/v1/numbers/check', { from: { clientId: 'shop1' }, to: '9876500002' }, inventory.key);
    expect(env.engine.calls.filter((c) => c.includes('whatsappNumbers')).length).toBe(calls);
  });

  it('admin lists never include message text or full numbers', async () => {
    await post('/v1/messages', msg({ text: 'secret words 12' }), inventory.key);
    const r = await get('/admin/messages', { 'x-admin-key': env.ctx.config.ADMIN_KEY });
    const raw = await r.text();
    expect(raw).not.toContain('secret words');
    expect(raw).not.toContain('919876543210');
    expect(raw).toContain('3210');
  });

  it('/health says ok and /ready checks database and engine', async () => {
    expect(await (await get('/health', {})).json() as any).toEqual({ status: 'ok' });
    const ready = await get('/ready', {});
    expect(ready.status).toBe(200);
    await env.engine.stop();
    const notReady = await get('/ready', {});
    expect(notReady.status).toBe(503);
    expect((await notReady.json() as any).engine).toBe(false);
    await env.engine.start(env.engine.port);
    expect((await get('/ready', {})).status).toBe(200);
  });
});
