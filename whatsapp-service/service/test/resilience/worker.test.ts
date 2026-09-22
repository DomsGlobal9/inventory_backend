import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Account, ModuleClient } from '@prisma/client';
import { hasTestDb, makeEnv, queueMessage, resetDb, seedClient, seedModule, seedScaleezy, sleep, waitFor, WebhookReceiver, type TestEnv } from '../helpers/setup';
import { Sender } from '../../src/worker/sender';
import { handleEngineEvent } from '../../src/events/engine-events';
import { dispatchDueEvents } from '../../src/events/module-events';
import { runHealthWatch } from '../../src/health/watch';
import { settleCanaries, startCanary } from '../../src/health/canary';

// The sending worker against a fake engine that misbehaves on purpose.

describe.skipIf(!hasTestDb)('worker resilience', () => {
  let env: TestEnv;
  let hook: WebhookReceiver;
  let shop: Account;
  let mod: ModuleClient;
  let sender: Sender;

  beforeAll(async () => {
    env = await makeEnv();
    hook = new WebhookReceiver();
    await hook.start();
  });
  afterAll(async () => {
    await hook.stop();
    await env.close();
  });
  beforeEach(async () => {
    await resetDb(env.db);
    env.engine.sends.length = 0;
    env.engine.nextSends.length = 0;
    env.engine.notOnWhatsApp.clear();
    env.engine.onSend = null;
    hook.received = [];
    hook.failWith = null;
    await seedScaleezy(env);
    shop = await seedClient(env, 'shop1');
    const seeded = await seedModule(env, 'inventory', { canSendAsScaleEzy: true, webhookUrl: hook.url });
    mod = seeded.mod;
    hook.secret = seeded.secret;
    sender = new Sender(env.ctx, { notReadyWaitMs: 50 });
  });

  /** One worker pass, waiting for all started work. */
  const step = async () => {
    await sleep(30); // lets the 0-20 ms human-like gap pass
    await sender.tick();
    await sender.idle();
  };
  const status = async (id: string) => (await env.db.message.findUniqueOrThrow({ where: { id } })).status;
  const dueNow = (id: string) => env.db.message.update({ where: { id }, data: { nextAttemptAt: new Date() } });
  const statusEvents = async (messageId: string) =>
    (await env.db.moduleEvent.findMany({ where: { type: 'message.status' }, orderBy: { createdAt: 'asc' } })).filter(
      (e) => (e.payload as { messageId: string }).messageId === messageId,
    );

  it('sends a text and a PDF, then wipes the PDF bytes', async () => {
    const t = await queueMessage(env, shop.id, mod.id);
    const d = await queueMessage(env, shop.id, mod.id, { document: new Uint8Array(Buffer.from('%PDF-1.4 x')), fileName: 'PO-1.pdf', mimeType: 'application/pdf', text: null });
    await step();
    await step();
    expect(await status(t.id)).toBe('SENT');
    expect(await status(d.id)).toBe('SENT');
    expect(env.engine.sends.map((s) => s.type).sort()).toEqual(['document', 'text']);
    expect((await env.db.message.findUniqueOrThrow({ where: { id: d.id } })).document).toBeNull();
  });

  it('engine down during send: the message stays QUEUED (no try used) and goes once the engine is back', async () => {
    const m = await queueMessage(env, shop.id, mod.id);
    await env.engine.stop();
    await step();
    let row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe('QUEUED');
    expect(row.tries).toBe(0);
    await step();
    expect(await status(m.id)).toBe('QUEUED');
    await env.engine.start(env.engine.port);
    await dueNow(m.id);
    await sleep(60);
    await step();
    row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe('SENT');
    expect(env.engine.sends).toHaveLength(1);
  });

  it('engine 5xx: retried with backoff, sent once when it recovers', async () => {
    const m = await queueMessage(env, shop.id, mod.id);
    env.engine.nextSends.push({ kind: 'status', status: 500 }, { kind: 'status', status: 503 });
    await step();
    let row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe('QUEUED');
    expect(row.tries).toBe(1);
    // Backoff: not tried again before its time.
    expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(20_000);
    await step();
    expect(env.engine.sends).toHaveLength(0);
    await dueNow(m.id);
    await step();
    row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.tries).toBe(2);
    expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(100_000);
    await dueNow(m.id);
    await step();
    expect(await status(m.id)).toBe('SENT');
    expect(env.engine.sends).toHaveLength(1);
  });

  it('engine 5xx three times: FAILED with a plain reason', async () => {
    const m = await queueMessage(env, shop.id, mod.id);
    env.engine.nextSends.push({ kind: 'status', status: 500 }, { kind: 'status', status: 500 }, { kind: 'status', status: 500 });
    for (let i = 0; i < 3; i++) {
      await dueNow(m.id);
      await step();
    }
    const row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe('FAILED');
    expect(row.failReason).toBe('WhatsApp could not send this after 3 tries. Please try again later.');
    expect(env.engine.sends).toHaveLength(0);
  });

  it('timeout although WhatsApp got it: the engine send event marks it SENT and it is never sent twice', async () => {
    const m = await queueMessage(env, shop.id, mod.id);
    env.engine.nextSends.push({ kind: 'slow', ms: 1500 }); // client gives up at 400 ms
    env.engine.onSend = async (s) => {
      // What Evolution posts right after a send, before answering the HTTP call.
      await handleEngineEvent(env.ctx, {
        event: 'send.message',
        instance: s.instance,
        data: { key: { id: s.engineMessageId, remoteJid: `${s.number}@s.whatsapp.net`, fromMe: true }, status: 'PENDING' },
      });
    };
    await step();
    const row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe('SENT');
    expect(row.engineMessageId).toBe(env.engine.sends[0]!.engineMessageId);
    await dueNow(m.id).catch(() => undefined);
    await step();
    await step();
    expect(env.engine.sends).toHaveLength(1);
  });

  it('a late send event after the timeout also stops the retry', async () => {
    const m = await queueMessage(env, shop.id, mod.id);
    env.engine.nextSends.push({ kind: 'slow', ms: 1000 });
    await step(); // times out, back to QUEUED with a try counted
    let row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe('QUEUED');
    expect(row.tries).toBe(1);
    const s = env.engine.sends[0]!;
    await handleEngineEvent(env.ctx, {
      event: 'send.message',
      instance: s.instance,
      data: { key: { id: s.engineMessageId, remoteJid: `${s.number}@s.whatsapp.net`, fromMe: true } },
    });
    row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe('SENT');
    await dueNow(m.id);
    await step();
    expect(env.engine.sends).toHaveLength(1);
  });

  it('delivered before sent, duplicates, out of order: never goes back, one module event per real change', async () => {
    const m = await queueMessage(env, shop.id, mod.id);
    // The engine reports "delivered" before its send call returns to us.
    env.engine.onSend = async (s) => {
      await handleEngineEvent(env.ctx, { event: 'messages.update', instance: s.instance, data: { keyId: s.engineMessageId, fromMe: true, status: 'DELIVERY_ACK' } });
    };
    await step();
    expect(await status(m.id)).toBe('DELIVERED');
    const id = env.engine.sends[0]!.engineMessageId;
    const upd = (st: string) => handleEngineEvent(env.ctx, { event: 'messages.update', instance: shop.instanceName, data: { keyId: id, fromMe: true, status: st } });
    await upd('DELIVERY_ACK');
    await upd('SERVER_ACK');
    await upd('DELIVERY_ACK');
    expect(await status(m.id)).toBe('DELIVERED');
    await upd('READ');
    await upd('DELIVERY_ACK');
    await upd('READ');
    expect(await status(m.id)).toBe('READ');
    const evs = await statusEvents(m.id);
    expect(evs.map((e) => (e.payload as { status: string }).status)).toEqual(['SENT', 'DELIVERED', 'READ']);
    // Delivered to the module, signed, each event id once.
    await dispatchDueEvents(env.ctx);
    const got = hook.received.filter((r) => r.data.messageId === m.id);
    expect(got.map((r) => r.data.status)).toEqual(['SENT', 'DELIVERED', 'READ']);
    expect(got.every((r) => r.signatureOk)).toBe(true);
    expect(new Set(got.map((r) => r.id)).size).toBe(3);
    await dispatchDueEvents(env.ctx);
    expect(hook.received.filter((r) => r.data.messageId === m.id)).toHaveLength(3);
  });

  it('a delivered tick for a message we did not send is kept aside, never applied elsewhere', async () => {
    await handleEngineEvent(env.ctx, { event: 'messages.update', instance: shop.instanceName, data: { keyId: 'UNKNOWN1', fromMe: true, status: 'READ' } });
    expect(await env.db.engineReceipt.count()).toBe(1);
    expect(await env.db.moduleEvent.count({ where: { type: 'message.status' } })).toBe(0);
  });

  it('module webhook down: retried, then recorded as failed, and sending carries on', async () => {
    hook.failWith = 500;
    const a = await queueMessage(env, shop.id, mod.id);
    await step();
    expect(await status(a.id)).toBe('SENT');
    let r = await dispatchDueEvents(env.ctx);
    expect(r.retried).toBe(1);
    // Sending is not blocked while the webhook fails.
    const b = await queueMessage(env, shop.id, mod.id, { text: 'second' });
    await step();
    expect(await status(b.id)).toBe('SENT');
    for (let i = 0; i < 3; i++) {
      await env.db.moduleEvent.updateMany({ data: { nextAttemptAt: new Date() } });
      r = await dispatchDueEvents(env.ctx);
    }
    const evA = (await statusEvents(a.id))[0]!;
    expect(evA.tries).toBe(3);
    expect(evA.failedAt).not.toBeNull();
    expect(evA.lastError).toBe('HTTP 500');
    // Webhook back: new events go through.
    hook.failWith = null;
    const c = await queueMessage(env, shop.id, mod.id, { text: 'third' });
    await step();
    await dispatchDueEvents(env.ctx);
    expect(hook.received.some((x) => x.data.messageId === c.id && x.signatureOk)).toBe(true);
  });

  it('module webhook that never answers does not hold up anything (timeout)', async () => {
    const { createServer } = await import('node:http');
    const black = createServer(() => undefined); // accepts, never answers
    await new Promise<void>((res) => black.listen(0, '127.0.0.1', res));
    const port = (black.address() as { port: number }).port;
    await env.db.moduleClient.update({ where: { id: mod.id }, data: { webhookUrl: `http://127.0.0.1:${port}/hook` } });
    const a = await queueMessage(env, shop.id, mod.id);
    await step();
    const t0 = Date.now();
    const r = await dispatchDueEvents(env.ctx, 20, 300);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.retried).toBe(1);
    expect(await status(a.id)).toBe('SENT');
    black.closeAllConnections();
    black.close();
  });

  it('number disconnected with messages queued: they wait, then expire after 24 h with the plain reason', async () => {
    await env.db.account.update({ where: { id: shop.id }, data: { status: 'DISCONNECTED' } });
    const a = await queueMessage(env, shop.id, mod.id);
    const b = await queueMessage(env, shop.id, mod.id, { text: 'b' });
    for (let i = 0; i < 3; i++) await step();
    expect(await status(a.id)).toBe('QUEUED');
    expect(await status(b.id)).toBe('QUEUED');
    expect(env.engine.sends).toHaveLength(0);
    await env.db.message.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { queuedAt: new Date(Date.now() - 25 * 3600_000) } });
    expect(await sender.expireOld()).toBe(2);
    const row = await env.db.message.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('EXPIRED');
    expect(row.failReason).toBe('Not sent within a day, so it was not sent late.');
    // Reconnected later: still never sent late.
    await env.db.account.update({ where: { id: shop.id }, data: { status: 'CONNECTED' } });
    await step();
    expect(env.engine.sends).toHaveLength(0);
    expect((await statusEvents(a.id)).map((e) => (e.payload as { status: string }).status)).toEqual(['EXPIRED']);
  });

  it('daily cap: over the cap stays QUEUED, never dropped', async () => {
    await env.db.account.update({ where: { id: shop.id }, data: { dailyCap: 1 } });
    const a = await queueMessage(env, shop.id, mod.id);
    const b = await queueMessage(env, shop.id, mod.id, { text: 'b' });
    await step();
    await step();
    await step();
    expect(await status(a.id)).toBe('SENT');
    expect(await status(b.id)).toBe('QUEUED');
    expect(env.engine.sends).toHaveLength(1);
  });

  it('a number not on WhatsApp fails with that reason, without sending', async () => {
    env.engine.notOnWhatsApp.add('919876543210');
    const a = await queueMessage(env, shop.id, mod.id);
    await step();
    const row = await env.db.message.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('FAILED');
    expect(row.failReason).toBe('This number is not on WhatsApp.');
    expect(env.engine.sends).toHaveLength(0);
  });

  it('crash recovery: a stale SENDING row with an engine id is marked SENT, never resent', async () => {
    const m = await queueMessage(env, shop.id, mod.id, { status: 'SENDING', engineMessageId: 'ENGINE-ID-1', sendingAt: new Date(Date.now() - 3 * 60_000) });
    const r = await sender.recoverStale();
    expect(r.confirmed).toBe(1);
    expect(await status(m.id)).toBe('SENT');
    await step();
    expect(env.engine.sends).toHaveLength(0);
  });

  it('crash recovery: a stale SENDING row without an engine id goes back to the queue and is sent once', async () => {
    const m = await queueMessage(env, shop.id, mod.id, { status: 'SENDING', sendingAt: new Date(Date.now() - 3 * 60_000) });
    const fresh = await queueMessage(env, shop.id, mod.id, { status: 'SENDING', sendingAt: new Date(), text: 'in flight elsewhere' });
    const r = await sender.recoverStale();
    expect(r.requeued).toBe(1);
    await step();
    expect(await status(m.id)).toBe('SENT');
    // A recent SENDING row (maybe still in flight) is left alone.
    expect(await status(fresh.id)).toBe('SENDING');
    expect(env.engine.sends).toHaveLength(1);
  });

  it('health watch: a logged-out number is recorded once and modules are told once', async () => {
    env.engine.setState(shop.instanceName, 'close', '919000000002', 401);
    const r1 = await runHealthWatch(env.ctx, { confirmDelayMs: 0 });
    expect(r1.changed).toBe(1);
    expect((await env.db.account.findUniqueOrThrow({ where: { id: shop.id } })).status).toBe('LOGGED_OUT');
    await runHealthWatch(env.ctx, { confirmDelayMs: 0 });
    const drops = await env.db.moduleEvent.findMany({ where: { type: 'account.disconnected' } });
    expect(drops).toHaveLength(1);
    expect((drops[0]!.payload as { clientId: string }).clientId).toBe('shop1');
    // The number itself is masked even in the signed event.
    expect(JSON.stringify(drops[0]!.payload)).not.toContain('919000000002');
  });

  it("health watch: ScaleEzy's own number logging out, and coming back, reach the module signed (its admin alert rests on this)", async () => {
    const sc = await env.db.account.findFirstOrThrow({ where: { kind: 'SCALEEZY' } });
    env.engine.setState(sc.instanceName, 'close', sc.phone!, 401);
    await runHealthWatch(env.ctx, { confirmDelayMs: 0 });
    env.engine.setState(sc.instanceName, 'open', sc.phone!);
    await runHealthWatch(env.ctx, { confirmDelayMs: 0 });
    await dispatchDueEvents(env.ctx);
    const got = hook.received.filter((r) => r.data.kind === 'SCALEEZY');
    expect(got.map((r) => [r.type, r.data.status])).toEqual([['account.disconnected', 'LOGGED_OUT'], ['account.connected', 'CONNECTED']]);
    expect(got.every((r) => r.signatureOk && r.data.clientId === null)).toBe(true);
    expect(JSON.stringify(got)).not.toContain(sc.phone!);
  });

  it('health watch: a blip that recovers within the confirm delay alarms nobody', async () => {
    env.engine.setState(shop.instanceName, 'connecting', '919000000002');
    setTimeout(() => env.engine.setState(shop.instanceName, 'open', '919000000002'), 100);
    await runHealthWatch(env.ctx, { confirmDelayMs: 300 });
    expect((await env.db.account.findUniqueOrThrow({ where: { id: shop.id } })).status).toBe('CONNECTED');
    expect(await env.db.moduleEvent.count({ where: { type: 'account.disconnected' } })).toBe(0);
  });

  it('health watch: engine down is not treated as every shop disconnecting', async () => {
    await env.engine.stop();
    const r = await runHealthWatch(env.ctx, { confirmDelayMs: 0 });
    expect(r.engineDown).toBe(true);
    expect((await env.db.account.findUniqueOrThrow({ where: { id: shop.id } })).status).toBe('CONNECTED');
    await env.engine.start(env.engine.port);
  });

  it('engine connection events: open records the phone, a logout fires one alert even if repeated', async () => {
    const acc = await env.db.account.create({ data: { kind: 'CLIENT', clientId: 'shop5', instanceName: 'client_shop5', status: 'LINKING' } });
    await handleEngineEvent(env.ctx, { event: 'connection.update', instance: 'client_shop5', data: { state: 'open', wuid: '919000000005@s.whatsapp.net', profileName: 'Shop 5' } });
    let row = await env.db.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.status).toBe('CONNECTED');
    expect(row.phone).toBe('919000000005');
    expect(row.linkedAt).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      await handleEngineEvent(env.ctx, { event: 'connection.update', instance: 'client_shop5', data: { state: 'close', statusReason: 401 } });
    }
    row = await env.db.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.status).toBe('LOGGED_OUT');
    expect(await env.db.moduleEvent.count({ where: { type: 'account.disconnected' } })).toBe(1);
    // A reconnecting blip from the engine does not change anything by itself.
    await env.db.account.update({ where: { id: acc.id }, data: { status: 'CONNECTED' } });
    await handleEngineEvent(env.ctx, { event: 'connection.update', instance: 'client_shop5', data: { state: 'connecting', statusReason: 200 } });
    expect((await env.db.account.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe('CONNECTED');
  });

  it('STOP reply opts the person out; the text is not stored', async () => {
    await handleEngineEvent(env.ctx, {
      event: 'messages.upsert',
      instance: shop.instanceName,
      data: { key: { remoteJid: '919876543210@s.whatsapp.net', fromMe: false, id: 'X1' }, message: { conversation: ' stop ' } },
    });
    await handleEngineEvent(env.ctx, {
      event: 'messages.upsert',
      instance: shop.instanceName,
      data: { key: { remoteJid: '919876543211@s.whatsapp.net', fromMe: false, id: 'X2' }, message: { conversation: 'please stop sending the old catalogue' } },
    });
    const outs = await env.db.optOut.findMany();
    expect(outs.map((o) => o.toDigits)).toEqual(['919876543210']);
    await handleEngineEvent(env.ctx, {
      event: 'messages.upsert',
      instance: shop.instanceName,
      data: { key: { remoteJid: '919876543210@s.whatsapp.net', fromMe: false, id: 'X3' }, message: { conversation: 'STOP' } },
    });
    expect(await env.db.moduleEvent.count({ where: { type: 'contact.opted_out' } })).toBe(1);
  });

  it('a STOP is answered once, and that is the only message the person ever gets again', async () => {
    const stop = (id: string) =>
      handleEngineEvent(env.ctx, {
        event: 'messages.upsert',
        instance: shop.instanceName,
        data: { key: { remoteJid: '919876543222@s.whatsapp.net', fromMe: false, id }, message: { conversation: 'STOP' } },
      });

    await stop('Y1');
    const ok = await env.db.message.findMany({ where: { kind: 'STOP_OK', toDigits: '919876543222' } });
    expect(ok).toHaveLength(1);
    expect(ok[0]!.text).toMatch(/will not get any more offers/i);
    // Nothing suggests it can be undone, because it cannot.
    expect(ok[0]!.text).not.toMatch(/reply|again|resubscribe|start/i);
    // It belongs to no module: the service sent it, not a shop.
    expect(ok[0]!.moduleId).toBeNull();

    // Saying STOP twice must not send a second one.
    await stop('Y2');
    expect(await env.db.message.count({ where: { kind: 'STOP_OK', toDigits: '919876543222' } })).toBe(1);

    await step();
    expect(await status(ok[0]!.id)).toBe('SENT');
    // That nothing else can reach them afterwards is checked over the real API in
    // api.test.ts ("a person who replied STOP is not messaged"); the helper here writes rows
    // straight to the database, so it would walk past the very check that matters.
  });

  it('the canary account (ScaleEzy) sends through the same queue', async () => {
    const sc = await env.db.account.findFirstOrThrow({ where: { kind: 'SCALEEZY' } });
    const m = await queueMessage(env, sc.id, null, { kind: 'TEST' });
    await step();
    expect(await status(m.id)).toBe('SENT');
    expect(await env.db.moduleEvent.count()).toBe(0);
  });

  it('an engine tick is recorded as engine confirmation without changing the status or telling the module twice', async () => {
    const m = await queueMessage(env, shop.id, mod.id);
    await step();
    const id = env.engine.sends[0]!.engineMessageId;
    await handleEngineEvent(env.ctx, { event: 'messages.update', instance: shop.instanceName, data: { keyId: id, fromMe: true, status: 'SERVER_ACK' } });
    await handleEngineEvent(env.ctx, { event: 'messages.update', instance: shop.instanceName, data: { keyId: id, fromMe: true, status: 'SERVER_ACK' } });
    const row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe('SENT');
    expect(row.engineConfirmedAt).not.toBeNull();
    expect((await statusEvents(m.id)).map((e) => (e.payload as { status: string }).status)).toEqual(['SENT']);
  });

  it('canary to the ScaleEzy number itself passes once the engine confirms it (no delivered tick exists for self)', async () => {
    const run = await startCanary(env.ctx);
    expect(run.outcome).toBe('PENDING');
    await step();
    const sent = env.engine.sends[0]!;
    expect(sent.number).toBe('919000000001'); // itself
    await settleCanaries(env.ctx);
    expect((await env.db.canaryRun.findUniqueOrThrow({ where: { id: run.id } })).outcome).toBe('PENDING');
    // The engine's send event (what arrives for a message to yourself).
    await handleEngineEvent(env.ctx, { event: 'send.message', instance: sent.instance, data: { key: { id: sent.engineMessageId, remoteJid: `${sent.number}@s.whatsapp.net`, fromMe: true } } });
    await settleCanaries(env.ctx);
    const done = await env.db.canaryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.outcome).toBe('OK');
    expect(done.detail).toMatch(/confirmed by the engine/);
  });

  it('canary to a second phone needs the delivered tick; without it, it fails after 10 minutes', async () => {
    const ctx2 = { ...env.ctx, config: { ...env.ctx.config, canaryTo: '9876500009' } };
    const run = await startCanary(ctx2);
    await step();
    const sent = env.engine.sends[0]!;
    expect(sent.number).toBe('919876500009');
    await handleEngineEvent(env.ctx, { event: 'messages.update', instance: sent.instance, data: { keyId: sent.engineMessageId, fromMe: true, status: 'SERVER_ACK' } });
    await settleCanaries(env.ctx);
    expect((await env.db.canaryRun.findUniqueOrThrow({ where: { id: run.id } })).outcome).toBe('PENDING');
    await settleCanaries(env.ctx, new Date(Date.now() + 11 * 60_000));
    const failed = await env.db.canaryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.outcome).toBe('FAILED');
    expect(failed.detail).toMatch(/Not delivered within 10 minutes/);
    // A second run that does get delivered passes.
    const run2 = await startCanary(ctx2);
    await step();
    const sent2 = env.engine.sends[1]!;
    await handleEngineEvent(env.ctx, { event: 'messages.update', instance: sent2.instance, data: { keyId: sent2.engineMessageId, fromMe: true, status: 'DELIVERY_ACK' } });
    await settleCanaries(env.ctx);
    expect((await env.db.canaryRun.findUniqueOrThrow({ where: { id: run2.id } })).outcome).toBe('OK');
  });

  it('graceful stop: no new work is started, the send in progress finishes', async () => {
    const a = await queueMessage(env, shop.id, mod.id);
    env.engine.nextSends.push({ kind: 'slow', ms: 250 });
    await sleep(30);
    await sender.tick(); // starts the slow send
    await waitFor(async () => (await status(a.id)) === 'SENDING');
    sender.stop();
    const b = await queueMessage(env, shop.id, mod.id, { text: 'after stop' });
    expect(await sender.drain(5000)).toBe(true);
    expect(await status(a.id)).toBe('SENT');
    await sender.tick();
    await sender.idle();
    expect(await status(b.id)).toBe('QUEUED');
    expect(env.engine.sends).toHaveLength(1);
  });
});
