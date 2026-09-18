import { Client } from 'pg';
import type { Logger } from 'pino';

// Only one service instance may send. Leadership is a Postgres session advisory lock held on a
// dedicated connection (not the pooled Prisma one, where a session lock could land on any
// connection). If that connection dies, Postgres releases the lock and another instance takes over;
// this instance notices on its next heartbeat and stops sending.

export const SENDER_LOCK_KEY = 815_142_4642; // arbitrary constant, same for every instance

export class LeaderLock {
  private client: Client | null = null;
  private held = false;

  constructor(
    private readonly databaseUrl: string,
    private readonly log: Logger,
    private readonly lockKey: number = SENDER_LOCK_KEY,
  ) {}

  get isHeld(): boolean {
    return this.held;
  }

  /** Tries once. Returns true if this instance now leads. */
  async tryAcquire(): Promise<boolean> {
    if (this.held) return true;
    try {
      if (!this.client) {
        const c = new Client({
          connectionString: this.databaseUrl,
          application_name: 'whatsapp-service-leader',
          // A dead connection must be noticed, not waited on: it is what proves leadership.
          keepAlive: true,
          connectionTimeoutMillis: 10_000,
          query_timeout: 10_000,
        });
        c.on('error', () => this.lost('lock connection error'));
        c.on('end', () => this.lost('lock connection ended'));
        await c.connect();
        this.client = c;
      }
      const r = await this.client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [this.lockKey]);
      this.held = r.rows[0]?.ok === true;
      return this.held;
    } catch {
      await this.dropClient();
      return false;
    }
  }

  /** Confirms the lock connection is alive. False means leadership is gone. */
  async heartbeat(): Promise<boolean> {
    if (!this.held || !this.client) return false;
    try {
      await this.client.query('SELECT 1');
      return this.held;
    } catch {
      this.lost('heartbeat failed');
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.client && this.held) {
      try {
        await this.client.query('SELECT pg_advisory_unlock($1)', [this.lockKey]);
      } catch {
        /* the connection closing below releases it anyway */
      }
    }
    this.held = false;
    await this.dropClient();
  }

  private lost(reason: string): void {
    if (this.held) this.log.warn({ reason }, 'lost sender leadership');
    this.held = false;
    void this.dropClient();
  }

  private async dropClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners('end');
      c.removeAllListeners('error');
      c.on('error', () => undefined);
      await c.end().catch(() => undefined);
    }
  }
}
