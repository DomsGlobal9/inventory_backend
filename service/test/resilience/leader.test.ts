import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createPrisma } from '../../src/db';
import { Runner } from '../../src/worker/runner';
import { hasTestDb, listen, makeEnv, queueMessage, resetDb, seedClient, seedModule, seedScaleezy, sleep, TcpProxy, TEST_DB_URL, waitFor, type TestEnv } from '../helpers/setup';
import type { Ctx } from '../../src/context';

// Several service instances, restarts and database outages, with the real Runner and lock.

const LOCK_KEY = 42_4242; // a key of its own so a locally running service is never affected
const runnerOpts = { lockKey: LOCK_KEY, leaderPollMs: 100, dispatchEveryMs: 100, notReadyWaitMs: 50, healthConfirmDelayMs: 0 };

describe.skipIf(!hasTestDb)('single sender, restarts, database outages', () => {
  let env: TestEnv;
  const runners: Runner[] = [];

  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(async () => {
    await resetDb(env.db);
    env.engine.sends.length = 0;
    env.engine.nextSends.length = 0;
  });
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.stop(5000)));
  });

  const start = (ctx: Ctx = env.ctx) => {
    const r = new Runner(ctx, runnerOpts);
    runners.push(r);
    r.start();
    return r;
  };

  it('two instances on one database: exactly one sends, every message goes exactly once', async () => {
    await seedScaleezy(env);
    const a1 = await seedClient(env, 'shopA', 'CONNECTED', '919000000011');
    const a2 = await seedClient(env, 'shopB', 'CONNECTED', '919000000012');
    const { mod } = await seedModule(env, 'inventory');
    // A second instance: its own database connections, same database, same engine.
    const db2 = createPrisma(TEST_DB_URL);
    const ctx2: Ctx = { ...env.ctx, db: db2 };
    const r1 = start();
    const r2 = start(ctx2);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await queueMessage(env, a1.id, mod.id, { text: `a${i}` })).id);
      ids.push((await queueMessage(env, a2.id, mod.id, { text: `b${i}`, toDigits: '919876500000' })).id);
    }
    await waitFor(async () => (await env.db.message.count({ where: { id: { in: ids }, status: 'SENT' } })) === ids.length, 20_000);
    expect([r1.isLeader, r2.isLeader].filter(Boolean)).toHaveLength(1);
    expect(env.engine.sends).toHaveLength(ids.length);
    // One number is never sending two messages at once, and each message went exactly once.
    const byMessage = await env.db.message.findMany({ where: { id: { in: ids } }, select: { engineMessageId: true } });
    expect(new Set(byMessage.map((m) => m.engineMessageId)).size).toBe(ids.length);

    // The leader stops (deploy): the other takes over at once and keeps sending.
    const leader = r1.isLeader ? r1 : r2;
    const other = leader === r1 ? r2 : r1;
    await leader.stop(5000);
    await waitFor(async () => other.isLeader, 5000);
    const late = await queueMessage(env, a1.id, mod.id, { text: 'after failover' });
    await waitFor(async () => (await env.db.message.findUniqueOrThrow({ where: { id: late.id } })).status === 'SENT', 10_000);
    expect(env.engine.sends).toHaveLength(ids.length + 1);
    await db2.$disconnect();
  });

  it('restart mid-send (graceful): the in-flight send finishes, the next instance does not send it again', async () => {
    await seedScaleezy(env);
    const shop = await seedClient(env, 'shopA', 'CONNECTED', '919000000011');
    const { mod } = await seedModule(env, 'inventory');
    env.engine.nextSends.push({ kind: 'slow', ms: 300 });
    const r1 = start();
    const m = await queueMessage(env, shop.id, mod.id);
    const second = await queueMessage(env, shop.id, mod.id, { text: 'second' });
    await waitFor(async () => (await env.db.message.findUniqueOrThrow({ where: { id: m.id } })).status === 'SENDING', 10_000, 10);
    await r1.stop(5000); // SIGTERM
    expect((await env.db.message.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('SENT');
    expect((await env.db.message.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('QUEUED');
    const r2 = start(); // the restarted service
    await waitFor(async () => r2.isLeader, 5000);
    await waitFor(async () => (await env.db.message.findUniqueOrThrow({ where: { id: second.id } })).status === 'SENT', 10_000);
    await sleep(300);
    expect(env.engine.sends).toHaveLength(2);
    expect(env.engine.sends.filter((s) => s.number === '919876543210')).toHaveLength(2);
  });

  it('database cut off for a while: /ready fails, the service recovers by itself and sends', async () => {
    const u = new URL(TEST_DB_URL);
    const proxy = new TcpProxy(u.hostname, Number(u.port || 5432));
    await proxy.start();
    const viaProxy = await makeEnv({ databaseUrl: proxy.urlFor(TEST_DB_URL) });
    const { url, server } = await listen(viaProxy.app);
    try {
      await seedScaleezy(viaProxy);
      const shop = await seedClient(viaProxy, 'shopA', 'CONNECTED', '919000000011');
      const { mod } = await seedModule(viaProxy, 'inventory');
      // The fake engine of this environment is its own; mirror the shop's state there.
      viaProxy.engine.setState(shop.instanceName, 'open', '919000000011');
      const r = new Runner(viaProxy.ctx, runnerOpts);
      runners.push(r);
      r.start();
      await waitFor(async () => r.isLeader, 5000);
      expect((await fetch(`${url}/ready`)).status).toBe(200);

      await proxy.stop(); // database gone
      const ready = await fetch(`${url}/ready`);
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as { db: boolean }).db).toBe(false);
      // A request that needs the database gets a plain 503, not a crash.
      const res = await fetch(`${url}/v1/accounts/client/shopA`, { headers: { 'x-module-key': 'wsk_whatever' } });
      expect([401, 503]).toContain(res.status);
      await sleep(1500);
      await waitFor(async () => !r.isLeader, 5000); // the lock connection died with it

      await proxy.start(proxy.port); // database back
      await waitFor(async () => (await fetch(`${url}/ready`)).status === 200, 15_000, 200);
      await waitFor(async () => r.isLeader, 10_000);
      // Queued through the main connection, sent by the recovered instance.
      const m = await queueMessage(env, shop.id, mod.id);
      await waitFor(async () => (await env.db.message.findUniqueOrThrow({ where: { id: m.id } })).status === 'SENT', 15_000).catch(async (e) => {
        const row = await env.db.message.findUniqueOrThrow({ where: { id: m.id } });
        const acc = await env.db.account.findUniqueOrThrow({ where: { id: shop.id } });
        throw new Error(`${(e as Error).message}: message ${row.status} tries ${row.tries} next ${row.nextAttemptAt.toISOString()} account ${acc.status} leader ${r.isLeader} sends ${viaProxy.engine.sends.length} calls ${viaProxy.engine.calls.slice(-5).join(',')}`);
      });
      expect(viaProxy.engine.sends).toHaveLength(1);
    } finally {
      server.close();
      await viaProxy.close();
      await proxy.stop();
    }
  });
});
