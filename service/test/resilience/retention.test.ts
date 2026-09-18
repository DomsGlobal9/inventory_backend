import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDb, makeEnv, resetDb, seedClient, seedModule, type TestEnv } from '../helpers/setup';
import { pruneOldRecords } from '../../src/worker/retention';

// Old records are removed; nothing still in use, and no STOP, ever is.

describe.skipIf(!hasTestDb)('retention', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  afterAll(async () => { await env.close(); });
  beforeEach(async () => { await resetDb(env.db); });

  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  it('deletes only finished messages past the retention period, and keeps every STOP', async () => {
    const account = await seedClient(env, 'shop1');
    const { mod } = await seedModule(env, 'inventory', { webhookUrl: 'http://127.0.0.1:9/never' });
    const make = (status: string, days: number) => env.db.message.create({
      data: { accountId: account.id, moduleId: mod.id, toDigits: '919876500000', kind: 'C1', idempotencyKey: `k-${status}-${days}-${Math.random()}`, contentHash: 'x', status: status as any, queuedAt: ago(days) },
    });
    const oldDelivered = await make('DELIVERED', 31);
    const oldExpired = await make('EXPIRED', 40);
    const recentDelivered = await make('DELIVERED', 5);
    const oldStillQueued = await make('QUEUED', 31);
    const oldStillSending = await make('SENDING', 31);

    const stop = await env.db.optOut.create({ data: { accountId: account.id, toDigits: '919876511111', createdAt: ago(900) } });
    const oldDeliveredEvent = await env.db.moduleEvent.create({ data: { moduleId: mod.id, type: 'message.status', payload: {}, deliveredAt: ago(8) } });
    const retrying = await env.db.moduleEvent.create({ data: { moduleId: mod.id, type: 'message.status', payload: {}, createdAt: ago(8), nextAttemptAt: ago(1) } });
    await env.db.accountStatusLog.create({ data: { accountId: account.id, from: 'CONNECTED', to: 'DISCONNECTED', source: 'test', at: ago(91) } });
    const recentLog = await env.db.accountStatusLog.create({ data: { accountId: account.id, from: 'DISCONNECTED', to: 'CONNECTED', source: 'test', at: ago(2) } });

    const r = await pruneOldRecords(env.ctx);

    const exists = async (id: string) => Boolean(await env.db.message.findUnique({ where: { id } }));
    expect(await exists(oldDelivered.id)).toBe(false);
    expect(await exists(oldExpired.id)).toBe(false);
    expect(await exists(recentDelivered.id)).toBe(true);
    expect(await exists(oldStillQueued.id)).toBe(true);
    expect(await exists(oldStillSending.id)).toBe(true);
    expect(r.messages).toBe(2);

    expect(await env.db.optOut.findUnique({ where: { id: stop.id } })).not.toBeNull();
    expect(await env.db.moduleEvent.findUnique({ where: { id: oldDeliveredEvent.id } })).toBeNull();
    expect(await env.db.moduleEvent.findUnique({ where: { id: retrying.id } })).not.toBeNull();
    expect(await env.db.accountStatusLog.count()).toBe(1);
    expect(await env.db.accountStatusLog.findUnique({ where: { id: recentLog.id } })).not.toBeNull();

    // Running again removes nothing more.
    const again = await pruneOldRecords(env.ctx);
    expect(Object.values(again).every(n => n === 0)).toBe(true);
  });

  it('the period follows MESSAGE_RETENTION_DAYS', async () => {
    const env90 = await makeEnv({ config: { MESSAGE_RETENTION_DAYS: '90' } });
    try {
      const account = await seedClient(env90, 'shop2');
      const m = await env90.db.message.create({
        data: { accountId: account.id, toDigits: '919876500000', kind: 'C1', idempotencyKey: `k-${Math.random()}`, contentHash: 'x', status: 'READ', queuedAt: ago(60) },
      });
      await pruneOldRecords(env90.ctx);
      expect(await env90.db.message.findUnique({ where: { id: m.id } })).not.toBeNull();
    } finally {
      await env90.close();
    }
  });
});
