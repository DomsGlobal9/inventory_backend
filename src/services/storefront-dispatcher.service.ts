import axios from 'axios';
import { prisma } from '../lib/prisma';
import { DeliveryStatus } from '@prisma/client';
import { checkUrlDestination } from '../utils/storefrontUrl';
import {
  sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, KEY_HEADER, DELIVERY_HEADER
} from '../utils/storefrontSignature';

/**
 * Sending queued deliveries.
 *
 * The failure this replaces is worth stating, because it is the reason for most of the shape
 * here: the previous dispatcher claimed a batch of rows (PENDING -> PROCESSING) and only then
 * checked whether a destination was configured. There was none, so it returned -- leaving the
 * rows claimed. Nothing ever selects PROCESSING again, so every event it ever touched was
 * stranded: 747 rows across 21 tenants, none delivered, over a fortnight.
 *
 * Three rules follow from that:
 *
 *   RESOLVE BEFORE CLAIMING   a row is only claimed once we know we can attempt it.
 *   EVERY CLAIM IS A LEASE    a claim carries a timestamp, and a stale one is reclaimed, so a
 *                             process dying mid-send costs one retry rather than a lost event.
 *   FAIRNESS BETWEEN TENANTS  the queue is drained per tenant, not oldest-first globally, so
 *                             one busy shop cannot starve the rest.
 */

/** How long a claim is honoured before another worker may take the row. */
const LEASE_MS = 2 * 60 * 1000;

/** Deliveries attempted per tenant per cycle. */
const PER_TENANT_LIMIT = 20;

/** Tenants worked per cycle. */
const TENANT_LIMIT = 25;

/** Attempts before a delivery is set aside. */
const MAX_ATTEMPTS = 8;

const REQUEST_TIMEOUT_MS = 10000;

/** Response body kept for the log, truncated: it is diagnostics, not storage. */
const ERROR_SNIPPET = 300;

/**
 * Exponential with a ceiling: roughly 30s, 1m, 2m, 4m, 8m, 16m, 30m, 30m. Jittered, so a
 * storefront that went down while a thousand deliveries were queued does not receive all of
 * them again in the same instant when it returns.
 */
function backoffMs(attempts: number): number {
  const base = Math.min(30_000 * 2 ** (attempts - 1), 30 * 60_000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export class StorefrontDispatcherService {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;

  static start(intervalMs = 30_000) {
    if (this.timer) return;
    const tick = () => { void StorefrontDispatcherService.runOnce(); };
    void tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    console.log('[StorefrontDispatcher] Started.');
  }

  static stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One pass. Exported so tests can drive it directly instead of waiting on a timer. */
  static async runOnce(): Promise<{ attempted: number; delivered: number; failed: number }> {
    if (this.running) return { attempted: 0, delivered: 0, failed: 0 };
    this.running = true;
    try {
      await this.reclaimStaleClaims();

      const tenants = await this.tenantsWithWork();
      let attempted = 0, delivered = 0, failed = 0;

      for (const clientId of tenants) {
        const batch = await this.claimForTenant(clientId);
        for (const delivery of batch) {
          attempted++;
          const ok = await this.attempt(delivery.id);
          if (ok) delivered++; else failed++;
        }
      }
      return { attempted, delivered, failed };
    } catch (error) {
      console.error('[StorefrontDispatcher] Cycle failed; will retry.', error);
      return { attempted: 0, delivered: 0, failed: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * A claim older than the lease means the worker holding it died. Returning the row to the
   * queue is the difference between one late delivery and a permanently lost one.
   */
  private static async reclaimStaleClaims() {
    const cutoff = new Date(Date.now() - LEASE_MS);
    const reclaimed = await prisma.storefrontDelivery.updateMany({
      where: { status: DeliveryStatus.PROCESSING, lockedAt: { lt: cutoff } },
      data: { status: DeliveryStatus.PENDING, lockedAt: null }
    });
    if (reclaimed.count > 0) {
      console.warn(`[StorefrontDispatcher] Reclaimed ${reclaimed.count} stale claim(s).`);
    }
  }

  private static async tenantsWithWork(): Promise<string[]> {
    const rows = await prisma.storefrontDelivery.groupBy({
      by: ['clientId'],
      where: {
        status: { in: [DeliveryStatus.PENDING, DeliveryStatus.RETRYING] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }]
      },
      _count: { id: true },
      // Fewest waiting first. With a cap on tenants per cycle, ordering by the largest backlog
      // would let one busy shop hold the front of the queue indefinitely; this way a tenant
      // with two waiting deliveries is not stuck behind one with two thousand.
      orderBy: { _count: { id: 'asc' } },
      take: TENANT_LIMIT
    });
    return rows.map(r => r.clientId);
  }

  /**
   * Claim a tenant's slice.
   *
   * The claim is guarded on the status it expected to find, so two workers racing for the same
   * row cannot both win -- only one updateMany matches.
   */
  private static async claimForTenant(clientId: string) {
    const candidates = await prisma.storefrontDelivery.findMany({
      where: {
        clientId,
        status: { in: [DeliveryStatus.PENDING, DeliveryStatus.RETRYING] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        // Resolved BEFORE claiming: a delivery whose connection cannot receive is never taken
        // out of the queue in the first place.
        connection: { status: { in: ['ACTIVE', 'PENDING_SYNC'] } }
      },
      orderBy: { createdAt: 'asc' },
      take: PER_TENANT_LIMIT,
      select: { id: true, status: true }
    });
    if (candidates.length === 0) return [];

    const now = new Date();
    const claimed: { id: string }[] = [];
    for (const candidate of candidates) {
      const result = await prisma.storefrontDelivery.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: { status: DeliveryStatus.PROCESSING, lockedAt: now }
      });
      if (result.count === 1) claimed.push({ id: candidate.id });
    }
    return claimed;
  }

  /** One delivery. Returns whether it landed. */
  private static async attempt(deliveryId: string): Promise<boolean> {
    const delivery = await prisma.storefrontDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true, attempts: true,
        event: {
          select: {
            id: true, sequence: true, eventType: true, eventVersion: true,
            clientId: true, payload: true, createdAt: true
          }
        },
        // Read now, not when the row was queued, so a rotated secret or a changed URL applies
        // to work already in the queue.
        connection: { select: { id: true, baseUrl: true, credentialPrefix: true, status: true, type: true } }
      }
    });
    if (!delivery) return false;

    if (delivery.connection.status === 'DISABLED' || delivery.connection.status === 'REVOKED') {
      await this.cancel(delivery.id, `Connection ${delivery.connection.status.toLowerCase()}`);
      return false;
    }

    // Everything below this line speaks the GENERIC contract: a signed JSON envelope POSTed to
    // a URL the merchant's developer built for us. Shopify does not have such an endpoint --
    // the direction is reversed, and we must call Shopify's Admin API with an OAuth token
    // instead.
    //
    // Without this check a Shopify connection would be handled here anyway. It would POST our
    // envelope at the shop's domain, Shopify would answer 404, and the delivery would retry for
    // days looking exactly like a network problem at the merchant's end. Failing with the real
    // reason costs one branch and saves that entire investigation.
    if (delivery.connection.type !== 'GENERIC') {
      await this.cancel(
        delivery.id,
        `Deliveries to a ${delivery.connection.type} storefront need that platform's adapter, ` +
        `which is not enabled on this deployment. Nothing was sent.`
      );
      return false;
    }

    // A storefront queued while PENDING_SYNC is deliberately not sent to: it has no catalogue
    // to apply the update against. The work waits rather than being discarded.
    if (delivery.connection.status === 'PENDING_SYNC') {
      await prisma.storefrontDelivery.update({
        where: { id: delivery.id },
        data: {
          status: DeliveryStatus.PENDING,
          lockedAt: null,
          nextAttemptAt: new Date(Date.now() + 60_000),
          lastError: 'Waiting for the storefront to complete its first catalogue sync'
        }
      });
      return false;
    }

    // Re-checked at send time, because DNS can be re-pointed at a private address after the
    // URL was accepted. That is the whole of DNS rebinding.
    const destination = await checkUrlDestination(delivery.connection.baseUrl);
    if (!destination.ok) {
      await this.fail(delivery.id, delivery.attempts + 1, null, `Refusing to send: ${destination.reason}`, 0);
      return false;
    }

    const secret = process.env.STOREFRONT_SIGNING_SECRET;
    if (!secret) {
      // Released, not left claimed. This is precisely the mistake that stranded the old outbox.
      await prisma.storefrontDelivery.update({
        where: { id: delivery.id },
        data: {
          status: DeliveryStatus.PENDING,
          lockedAt: null,
          nextAttemptAt: new Date(Date.now() + 60_000),
          lastError: 'STOREFRONT_SIGNING_SECRET is not configured'
        }
      });
      console.warn('[StorefrontDispatcher] STOREFRONT_SIGNING_SECRET not set; deliveries requeued, not dropped.');
      return false;
    }

    const body = JSON.stringify({
      eventVersion: delivery.event.eventVersion,
      eventId: delivery.event.id,
      // What a receiver orders by and discards stale updates on.
      sequence: delivery.event.sequence.toString(),
      eventType: delivery.event.eventType,
      clientId: delivery.event.clientId,
      occurredAt: delivery.event.createdAt.toISOString(),
      data: delivery.event.payload
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const startedAt = Date.now();

    try {
      const response = await axios.post(delivery.connection.baseUrl, body, {
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 0, // a redirect could point anywhere, including inside our network
        maxContentLength: 64 * 1024,
        headers: {
          'Content-Type': 'application/json',
          [KEY_HEADER]: delivery.connection.credentialPrefix,
          [TIMESTAMP_HEADER]: String(timestamp),
          [DELIVERY_HEADER]: delivery.id,
          [SIGNATURE_HEADER]: sign(secret, timestamp, body)
        },
        validateStatus: () => true
      });

      const duration = Date.now() - startedAt;

      if (response.status >= 200 && response.status < 300) {
        await prisma.$transaction([
          prisma.storefrontDelivery.update({
            where: { id: delivery.id },
            data: {
              status: DeliveryStatus.DELIVERED,
              attempts: delivery.attempts + 1,
              lastAttemptAt: new Date(),
              deliveredAt: new Date(),
              lastResponseStatus: response.status,
              lastDurationMs: duration,
              lastError: null,
              lockedAt: null
            }
          }),
          prisma.storefrontConnection.update({
            where: { id: delivery.connection.id },
            data: { lastDeliveryAt: new Date() }
          })
        ]);
        return true;
      }

      // A receiver asking us to slow down is obeyed rather than overridden by our own curve.
      const retryAfter = Number(response.headers['retry-after']);
      await this.fail(
        delivery.id,
        delivery.attempts + 1,
        response.status,
        `HTTP ${response.status}: ${String(response.data).slice(0, ERROR_SNIPPET)}`,
        duration,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
      );
      return false;
    } catch (error: any) {
      await this.fail(
        delivery.id, delivery.attempts + 1, null,
        String(error?.message || error).slice(0, ERROR_SNIPPET),
        Date.now() - startedAt
      );
      return false;
    }
  }

  private static async fail(
    id: string, attempts: number, responseStatus: number | null,
    message: string, durationMs: number, retryAfterMs?: number
  ) {
    const exhausted = attempts >= MAX_ATTEMPTS;
    await prisma.storefrontDelivery.update({
      where: { id },
      data: {
        status: exhausted ? DeliveryStatus.DEAD_LETTER : DeliveryStatus.RETRYING,
        attempts,
        lastAttemptAt: new Date(),
        lastResponseStatus: responseStatus,
        lastError: message,
        lastDurationMs: durationMs,
        lockedAt: null,
        nextAttemptAt: exhausted ? null : new Date(Date.now() + (retryAfterMs ?? backoffMs(attempts)))
      }
    });
  }

  private static async cancel(id: string, reason: string) {
    await prisma.storefrontDelivery.update({
      where: { id },
      data: { status: DeliveryStatus.CANCELLED, lastError: reason, lockedAt: null, nextAttemptAt: null }
    });
  }
}
