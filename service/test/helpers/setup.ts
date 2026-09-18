import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket, type AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import { loadConfig, type Config } from '../../src/config';
import { createPrisma, type Db } from '../../src/db';
import { EvolutionEngine } from '../../src/engine/client';
import { createLogger } from '../../src/lib/logger';
import { loadDotEnv } from '../../src/lib/dotenv';
import { encrypt, hashModuleKey, newModuleKey, newWebhookSecret, verifySignature } from '../../src/lib/crypto';
import { createApp } from '../../src/http/app';
import type { Ctx } from '../../src/context';
import { FakeEngine } from './fake-engine';

loadDotEnv();
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? '';
export const hasTestDb = TEST_DB_URL.length > 0;

export const SCALEEZY_INSTANCE = 'scaleezy-test';
export const SCALEEZY_PHONE = '919000000001';

export function testConfig(databaseUrl: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    ENGINE_URL: 'http://127.0.0.1:1',
    ENGINE_API_KEY: 'test-engine-key-0123456789',
    ENGINE_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
    ADMIN_KEY: 'test-admin-key-0123456789abcdef',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SCALEEZY_INSTANCE,
    SCALEEZY_DAILY_CAP: '100',
    SEND_GAP_MIN_MS: '0',
    SEND_GAP_MAX_MS: '20',
    WORKER_TICK_MS: '50',
    HEALTH_WATCH_INTERVAL_MS: '3600000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export interface TestEnv {
  ctx: Ctx;
  engine: FakeEngine;
  db: Db;
  app: Express;
  close: () => Promise<void>;
}

export async function makeEnv(opts: { databaseUrl?: string; config?: Record<string, string> } = {}): Promise<TestEnv> {
  const engine = new FakeEngine();
  await engine.start();
  const config = testConfig(opts.databaseUrl ?? TEST_DB_URL, { ENGINE_URL: engine.url, ...(opts.config ?? {}) });
  const db = createPrisma(config.DATABASE_URL);
  const ctx: Ctx = {
    db,
    engine: new EvolutionEngine({ baseUrl: config.ENGINE_URL, apiKey: config.ENGINE_API_KEY, timeoutMs: 1500, sendTimeoutMs: 400 }),
    config,
    log: createLogger('silent'),
  };
  return {
    ctx,
    engine,
    db,
    app: createApp(ctx),
    close: async () => {
      await engine.stop();
      await db.$disconnect();
    },
  };
}

/** Empties every table (tests share one throwaway database). */
export async function resetDb(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "ModuleEvent", "Message", "OptOut", "AccountStatusLog", "Account", "ModuleClient", "NumberCheck", "EngineReceipt", "CanaryRun" CASCADE',
  );
}

export async function seedScaleezy(env: TestEnv, status: 'CONNECTED' | 'DISCONNECTED' = 'CONNECTED') {
  env.engine.setState(SCALEEZY_INSTANCE, status === 'CONNECTED' ? 'open' : 'connecting', SCALEEZY_PHONE);
  return env.db.account.create({
    data: { kind: 'SCALEEZY', instanceName: SCALEEZY_INSTANCE, phone: SCALEEZY_PHONE, status, linkedAt: new Date(Date.now() - 30 * 86400_000) },
  });
}

export async function seedClient(env: TestEnv, clientId: string, status: 'CONNECTED' | 'DISCONNECTED' = 'CONNECTED', phone = '919000000002') {
  const instanceName = `client_${clientId}`;
  env.engine.setState(instanceName, status === 'CONNECTED' ? 'open' : 'connecting', phone);
  return env.db.account.create({
    data: { kind: 'CLIENT', clientId, instanceName, phone, status, linkedAt: new Date(Date.now() - 30 * 86400_000) },
  });
}

export async function seedModule(env: TestEnv, name: string, opts: { canSendAsScaleEzy?: boolean; webhookUrl?: string } = {}) {
  const key = newModuleKey();
  const secret = newWebhookSecret();
  const mod = await env.db.moduleClient.create({
    data: {
      name,
      keyHash: hashModuleKey(key),
      canSendAsScaleEzy: opts.canSendAsScaleEzy ?? false,
      webhookUrl: opts.webhookUrl ?? null,
      webhookSecretEncrypted: opts.webhookUrl ? encrypt(secret, env.ctx.config.ENCRYPTION_KEY) : null,
    },
  });
  return { mod, key, secret };
}

export function queueMessage(env: TestEnv, accountId: string, moduleId: string | null, over: Record<string, unknown> = {}) {
  return env.db.message.create({
    data: {
      accountId,
      moduleId,
      toDigits: '919876543210',
      kind: 'C1',
      idempotencyKey: `k-${randomBytes(6).toString('hex')}`,
      contentHash: randomBytes(8).toString('hex'),
      text: 'hello',
      ...over,
    },
  });
}

export async function listen(app: Express): Promise<{ url: string; server: Server }> {
  const server = createHttpServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, everyMs = 50): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A module's webhook endpoint that records what it gets, checks signatures, and can be made to fail. */
export class WebhookReceiver {
  private server: Server | null = null;
  received: Array<{ id: string; type: string; data: Record<string, unknown>; signatureOk: boolean }> = [];
  failWith: number | null = null;
  secret = '';
  port = 0;
  get url() {
    return `http://127.0.0.1:${this.port}/hook`;
  }
  async start(): Promise<void> {
    this.server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (this.failWith) {
          res.writeHead(this.failWith).end();
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw) as { id: string; type: string; data: Record<string, unknown> };
        this.received.push({ ...body, signatureOk: verifySignature(this.secret, raw, req.headers['x-signature'] as string | undefined) });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }
}

/** A TCP proxy in front of Postgres, so a test can cut the database off and bring it back. */
export class TcpProxy {
  private server: TcpServer | null = null;
  private sockets = new Set<Socket>();
  port = 0;
  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}
  async start(port = 0): Promise<void> {
    this.server = createTcpServer((client) => {
      const upstream = connect(this.targetPort, this.targetHost);
      this.sockets.add(client).add(upstream);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((r) => this.server!.listen(port || this.port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }
  urlFor(dbUrl: string): string {
    const u = new URL(dbUrl);
    u.hostname = '127.0.0.1';
    u.port = String(this.port);
    return u.toString();
  }
}
