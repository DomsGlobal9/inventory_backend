import crypto from 'crypto';
import { DeliveryStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { backoffMs } from '../../utils/retryBackoff';
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, DELIVERY_HEADER } from '../../utils/storefrontSignature';

/**
 * The module outbox: every change another ScaleEzy module (CRM now, Finance next) needs from
 * Inventory, delivered to that module signed, in order, and retried until it lands.
 *
 * The events are not written here. Database triggers write them (migration
 * 20261028120000_module_outbox) in the same transaction as the change, for every shop listed in
 * module_subscriptions -- so a till sale arriving over the POS link, a Shopify order, a bulk update
 * and a script all produce one, and none can be forgotten by a code path that did not know about it.
 *
 * What this file does:
 *   - switches a shop on or off for a module (the module asks, over /api/v1/internal);
 *   - sends waiting events, per shop strictly in sequence order, in signed batches;
 *   - keeps the table small.
 *
 * Wire: POST <module url> with {module, clientId, source: 'inventory', events: [...]}; headers as
 * every Inventory webhook (utils/storefrontSignature.ts): timestamp, sha256 HMAC over
 * `timestamp.body`, and a delivery id stable across retries. Each event carries its id and sequence,
 * so the receiver stores first, ignores an id it has seen, and applies by sequence.
 */

/** Logistics (28 Oct): switched on per shop like CRM, but it is NOT sent the general change feed --
 * only its own parcel events (migration 20261028230000). */
export const MODULES = ['crm', 'logistics'] as const;
export type ModuleName = typeof MODULES[number];

type Destination = { url: string; secret: string };
/** Where each module receives, from the environment. A module with no address keeps its events waiting. */
export function destinationFor(module: string): Destination | null {
  const key = module.toUpperCase();
  const url = process.env[`${key}_EVENTS_URL`];
  const secret = process.env[`${key}_EVENTS_SECRET`];
  return url && secret ? { url, secret } : null;
}

const BATCH = 100;
const CLIENTS_PER_PASS = 50;
const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 12;
const TIMEOUT_MS = 15_000;
const KEEP_DELIVERED_DAYS = 14;

export const moduleSubscriptions = {
  async enable(clientId: string, module: ModuleName, enabledBy: string) {
    return prisma.moduleSubscription.upsert({
      where: { clientId_module: { clientId, module } },
      create: { clientId, module, enabledBy },
      update: {}
    });
  },

  /** Switched off: nothing more is written, and what was waiting is never sent. */
  async disable(clientId: string, module: ModuleName) {
    const [removed, cancelled] = await prisma.$transaction([
      prisma.moduleSubscription.deleteMany({ where: { clientId, module } }),
      prisma.moduleEvent.updateMany({
        where: { clientId, module, status: { in: [DeliveryStatus.PENDING, DeliveryStatus.RETRYING] } },
        data: { status: DeliveryStatus.CANCELLED, nextAttemptAt: null }
      })
    ]);
    return { removed: removed.count, cancelled: cancelled.count };
  },

  async list(module: ModuleName) {
    return prisma.moduleSubscription.findMany({ where: { module }, orderBy: { enabledAt: 'asc' } });
  }
};

type Row = { id: string; sequence: bigint; client_id: string; module: string; kind: string; source_table: string; row_id: string; payload: unknown; created_at: Date; attempts: number };

export class ModuleOutboxDispatcher {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static warnedNoDestination = new Set<string>();
  private static lastPrune = 0;

  static start(intervalMs = 5_000) {
    if (this.timer) return;
    const tick = () => { void ModuleOutboxDispatcher.runOnce(); };
    void tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    console.log('[ModuleOutbox] Started.');
  }

  static stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * One pass. Exported so tests can drive it instead of waiting on the timer; a test passes
   * `onlyClients` so it never sends (or fails) another shop's waiting events.
   */
  static async runOnce(opts: { onlyClients?: string[] } = {}): Promise<{ batches: number; delivered: number; failed: number }> {
    if (this.running) return { batches: 0, delivered: 0, failed: 0 };
    this.running = true;
    let batches = 0, delivered = 0, failed = 0;
    try {
      await prisma.moduleEvent.updateMany({
        where: { status: DeliveryStatus.PROCESSING, lockedAt: { lt: new Date(Date.now() - LEASE_MS) } },
        data: { status: DeliveryStatus.PENDING, lockedAt: null }
      });

      // A shop is ready when its OLDEST waiting event is due: later ones never overtake it, so a
      // module receives each shop's changes in the order they happened.
      const ready = await prisma.$queryRaw<{ module: string; client_id: string }[]>`
        SELECT e.module, e.client_id
        FROM (SELECT module, client_id, MIN(sequence) AS s FROM module_events
              WHERE status IN ('PENDING', 'RETRYING') GROUP BY module, client_id) w
        JOIN module_events e ON e.sequence = w.s
        WHERE (e.next_attempt_at IS NULL OR e.next_attempt_at <= NOW())
          ${opts.onlyClients ? Prisma.sql`AND e.client_id IN (${Prisma.join(opts.onlyClients.length ? opts.onlyClients : [''])})` : Prisma.empty}
        ORDER BY e.sequence
        LIMIT ${CLIENTS_PER_PASS}`;

      for (const { module, client_id } of ready) {
        const to = destinationFor(module);
        if (!to) {
          if (!this.warnedNoDestination.has(module)) {
            console.warn(`[ModuleOutbox] No ${module.toUpperCase()}_EVENTS_URL/_SECRET set; ${module} events wait until it is.`);
            this.warnedNoDestination.add(module);
          }
          continue;
        }
        const rows = await this.claim(module, client_id);
        if (rows.length === 0) continue;
        batches++;
        const ok = await this.send(module, client_id, rows, to);
        if (ok) delivered += rows.length; else failed += rows.length;
      }

      if (Date.now() - this.lastPrune > 60 * 60 * 1000) {
        this.lastPrune = Date.now();
        await prisma.moduleEvent.deleteMany({
          where: { status: { in: [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED] }, createdAt: { lt: new Date(Date.now() - KEEP_DELIVERED_DAYS * 86_400_000) } }
        });
      }
    } catch (error) {
      console.error('[ModuleOutbox] Pass failed; will retry.', error);
    } finally {
      this.running = false;
    }
    return { batches, delivered, failed };
  }

  /**
   * Takes the shop's next waiting events, guarded so two passes can never both take one.
   *
   * A retry is the same batch again, not that batch plus whatever changed meanwhile: when the oldest
   * waiting event is a retry, only the retrying events are taken (they failed together, as one
   * batch), so the delivery id the receiver saw the first time is the one it sees again.
   */
  private static claim(module: string, clientId: string) {
    return prisma.$queryRaw<Row[]>`
      UPDATE module_events SET status = 'PROCESSING', locked_at = NOW()
      WHERE id IN (
        SELECT id FROM module_events
        WHERE module = ${module} AND client_id = ${clientId}
          AND status = (SELECT status FROM module_events
                        WHERE module = ${module} AND client_id = ${clientId} AND status IN ('PENDING', 'RETRYING')
                        ORDER BY sequence LIMIT 1)
        ORDER BY sequence
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED)
      RETURNING id, sequence, client_id, module, kind, source_table, row_id, payload, created_at, attempts`;
  }

  private static async send(module: string, clientId: string, rows: Row[], to: Destination): Promise<boolean> {
    rows.sort((a, b) => (a.sequence < b.sequence ? -1 : 1));
    const body = JSON.stringify({
      module,
      clientId,
      source: 'inventory',
      events: rows.map(r => ({
        id: r.id,
        sequence: r.sequence.toString(),
        kind: r.kind,
        table: r.source_table,
        rowId: r.row_id,
        occurredAt: r.created_at.toISOString(),
        payload: r.payload
      }))
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const deliveryId = crypto.createHash('sha256').update(rows.map(r => r.id).join(',')).digest('hex').slice(0, 32);
    const ids = rows.map(r => r.id);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(to.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: sign(to.secret, timestamp, body),
          [DELIVERY_HEADER]: deliveryId
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      status = res.status;
      if (res.ok) {
        await prisma.moduleEvent.updateMany({
          where: { id: { in: ids } },
          data: { status: DeliveryStatus.DELIVERED, deliveredAt: new Date(), lockedAt: null, lastResponseStatus: status, lastError: null }
        });
        return true;
      }
      error = `HTTP ${status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 300);
    }
    // The whole batch waits together, so the shop's order is kept on the retry too.
    const attempts = Math.max(...rows.map(r => r.attempts)) + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    await prisma.moduleEvent.updateMany({
      where: { id: { in: ids } },
      data: {
        status: exhausted ? DeliveryStatus.DEAD_LETTER : DeliveryStatus.RETRYING,
        attempts,
        lockedAt: null,
        nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs(attempts)),
        lastResponseStatus: status,
        lastError: error
      }
    });
    if (exhausted) console.error(`[ModuleOutbox] ${module} gave up on ${ids.length} event(s) for ${clientId} after ${attempts} tries: ${error}`);
    return false;
  }
}

/** Events for one shop after a sequence number: the module's way to catch up or check for gaps. */
export async function eventsAfter(module: ModuleName, clientId: string, after: bigint, limit: number) {
  const rows = await prisma.moduleEvent.findMany({
    where: { module, clientId, sequence: { gt: after } },
    orderBy: { sequence: 'asc' },
    take: Math.min(Math.max(1, limit), 500),
    select: { id: true, sequence: true, kind: true, sourceTable: true, rowId: true, createdAt: true, payload: true, status: true }
  });
  return rows.map(r => ({ id: r.id, sequence: r.sequence.toString(), kind: r.kind, table: r.sourceTable, rowId: r.rowId, occurredAt: r.createdAt.toISOString(), payload: r.payload as Prisma.JsonValue, delivery: r.status }));
}
