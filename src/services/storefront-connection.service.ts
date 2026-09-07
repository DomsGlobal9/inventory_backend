import { prisma } from '../lib/prisma';
import { StorefrontConnectionStatus, StorefrontConnectionType, DeliveryStatus } from '@prisma/client';
import { generateCredential } from '../utils/storefrontCredential';
import { checkUrlShape, checkUrlDestination } from '../utils/storefrontUrl';

/**
 * The lifecycle of a merchant's storefront connection.
 *
 * A shop may have several -- a website, a marketplace, a staging site -- each with its own
 * credential, its own location scope and its own delivery history, so one can be paused or
 * revoked without touching the others.
 *
 * States and what they mean:
 *
 *   PENDING_SYNC  created, but the storefront has not pulled the catalogue yet. Events are
 *                 recorded and queued but NOT sent: telling a website that a price changed
 *                 before it has the product is noise it cannot act on.
 *   ACTIVE        synced and receiving.
 *   DISABLED      paused by the merchant. Queued work is cancelled rather than piling up.
 *   REVOKED       terminal. The credential can never be used again; history survives.
 */

export interface ConnectionInput {
  name: string;
  baseUrl: string;
  type?: StorefrontConnectionType;
  /** Empty means every location. */
  locationIds?: string[];
}

export class StorefrontConnectionService {
  /**
   * Creating a connection returns the only copy of its secret that will ever exist. The caller
   * must show it to the merchant immediately; it is not recoverable afterwards.
   */
  async create(clientId: string, input: ConnectionInput) {
    const shape = checkUrlShape(input.baseUrl);
    if (!shape.ok) throw Object.assign(new Error(shape.reason!), { statusCode: 400 });

    const destination = await checkUrlDestination(input.baseUrl);
    if (!destination.ok) throw Object.assign(new Error(destination.reason!), { statusCode: 400 });

    await this.assertLocationsBelongToTenant(clientId, input.locationIds ?? []);

    const credential = generateCredential();
    const connection = await prisma.storefrontConnection.create({
      data: {
        clientId,
        name: input.name.trim(),
        type: input.type ?? 'GENERIC',
        baseUrl: input.baseUrl.trim(),
        credentialHash: credential.hash,
        credentialPrefix: credential.prefix,
        locationIds: input.locationIds ?? [],
        status: 'PENDING_SYNC'
      }
    });

    return { connection, secret: credential.plaintext };
  }

  async list(clientId: string) {
    return prisma.storefrontConnection.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, name: true, type: true, status: true, baseUrl: true,
        credentialPrefix: true, locationIds: true,
        syncedAt: true, lastDeliveryAt: true, createdAt: true
      }
    });
  }

  async get(clientId: string, id: string) {
    return prisma.storefrontConnection.findFirst({
      where: { id, clientId },
      select: {
        id: true, name: true, type: true, status: true, baseUrl: true,
        credentialPrefix: true, locationIds: true,
        syncCursor: true, syncedAt: true, lastDeliveryAt: true, createdAt: true
      }
    });
  }

  async update(clientId: string, id: string, input: Partial<ConnectionInput>) {
    const existing = await prisma.storefrontConnection.findFirst({ where: { id, clientId } });
    if (!existing) throw Object.assign(new Error('Connection not found'), { statusCode: 404 });
    if (existing.status === 'REVOKED') {
      throw Object.assign(new Error('A revoked connection cannot be edited.'), { statusCode: 400 });
    }

    if (input.baseUrl) {
      const shape = checkUrlShape(input.baseUrl);
      if (!shape.ok) throw Object.assign(new Error(shape.reason!), { statusCode: 400 });
      const destination = await checkUrlDestination(input.baseUrl);
      if (!destination.ok) throw Object.assign(new Error(destination.reason!), { statusCode: 400 });
    }

    if (input.locationIds) await this.assertLocationsBelongToTenant(clientId, input.locationIds);

    return prisma.storefrontConnection.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.baseUrl ? { baseUrl: input.baseUrl.trim() } : {}),
        ...(input.locationIds ? { locationIds: input.locationIds } : {})
      }
    });
  }

  /**
   * Pausing cancels queued work rather than letting it accumulate. A merchant who pauses for a
   * week and resumes does not want a week of stale updates arriving at once -- and with
   * absolute-state events they do not need them: the next real change carries current truth,
   * and an incremental sync closes any gap.
   */
  async disable(clientId: string, id: string) {
    const connection = await this.requireOwned(clientId, id);
    if (connection.status === 'REVOKED') {
      throw Object.assign(new Error('A revoked connection cannot be re-enabled.'), { statusCode: 400 });
    }

    await prisma.$transaction([
      prisma.storefrontConnection.update({ where: { id }, data: { status: 'DISABLED' } }),
      prisma.storefrontDelivery.updateMany({
        where: { connectionId: id, status: { in: ['PENDING', 'RETRYING', 'PROCESSING'] } },
        data: { status: 'CANCELLED', lastError: 'Connection disabled' }
      })
    ]);
    return this.get(clientId, id);
  }

  /**
   * Re-enabling returns to PENDING_SYNC, not straight to ACTIVE. Whatever changed while it was
   * paused was never delivered, so the storefront must reconcile before it can be trusted to be
   * in step. That is a sync, not a resumption.
   */
  async enable(clientId: string, id: string) {
    const connection = await this.requireOwned(clientId, id);
    if (connection.status === 'REVOKED') {
      throw Object.assign(new Error('A revoked connection cannot be re-enabled.'), { statusCode: 400 });
    }
    await prisma.storefrontConnection.update({
      where: { id }, data: { status: 'PENDING_SYNC', syncCursor: null }
    });
    return this.get(clientId, id);
  }

  /**
   * Terminal. The credential is dead immediately -- not at next rotation -- and queued work is
   * cancelled. The row and its delivery history remain, because "what did we send this
   * storefront, and when" is a question that outlives the connection.
   */
  async revoke(clientId: string, id: string) {
    await this.requireOwned(clientId, id);
    await prisma.$transaction([
      prisma.storefrontConnection.update({
        where: { id },
        // Overwritten with a value no credential can hash to, so even a leaked backup of the
        // old row cannot be used against the live record.
        data: { status: 'REVOKED', credentialHash: 'revoked' }
      }),
      prisma.storefrontDelivery.updateMany({
        where: { connectionId: id, status: { in: ['PENDING', 'RETRYING', 'PROCESSING'] } },
        data: { status: 'CANCELLED', lastError: 'Connection revoked' }
      })
    ]);
    return this.get(clientId, id);
  }

  /** Issues a new secret and invalidates the old one immediately. */
  async rotateCredential(clientId: string, id: string) {
    const connection = await this.requireOwned(clientId, id);
    if (connection.status === 'REVOKED') {
      throw Object.assign(new Error('A revoked connection cannot be rotated.'), { statusCode: 400 });
    }

    const credential = generateCredential();
    await prisma.storefrontConnection.update({
      where: { id },
      data: { credentialHash: credential.hash, credentialPrefix: credential.prefix }
    });
    return { secret: credential.plaintext, prefix: credential.prefix };
  }

  /** The delivery log the merchant sees. Never includes secrets or full request bodies. */
  async deliveries(clientId: string, id: string, limit = 50) {
    await this.requireOwned(clientId, id);
    return prisma.storefrontDelivery.findMany({
      where: { connectionId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true, status: true, attempts: true,
        lastResponseStatus: true, lastError: true, lastDurationMs: true,
        nextAttemptAt: true, lastAttemptAt: true, deliveredAt: true, createdAt: true,
        event: { select: { eventType: true, sku: true, productCode: true, sequence: true } }
      }
    });
  }

  /** Puts a dead-lettered or cancelled delivery back in the queue, by hand, from the log. */
  async retryDelivery(clientId: string, deliveryId: string) {
    const delivery = await prisma.storefrontDelivery.findFirst({
      where: { id: deliveryId, clientId },
      select: { id: true, status: true, connection: { select: { status: true } } }
    });
    if (!delivery) throw Object.assign(new Error('Delivery not found'), { statusCode: 404 });
    if (delivery.connection.status === 'REVOKED') {
      throw Object.assign(new Error('That connection has been revoked.'), { statusCode: 400 });
    }
    if (delivery.status === 'DELIVERED') {
      throw Object.assign(new Error('That delivery already succeeded.'), { statusCode: 400 });
    }

    return prisma.storefrontDelivery.update({
      where: { id: deliveryId },
      data: { status: 'PENDING', nextAttemptAt: new Date(), attempts: 0, lockedAt: null, lastError: null }
    });
  }

  private async requireOwned(clientId: string, id: string) {
    const connection = await prisma.storefrontConnection.findFirst({ where: { id, clientId } });
    if (!connection) throw Object.assign(new Error('Connection not found'), { statusCode: 404 });
    return connection;
  }

  /**
   * A connection may only be scoped to locations its own tenant owns. Without this a merchant
   * could paste another tenant's location id and read stock they do not own -- the one boundary
   * this whole feature must never cross.
   */
  private async assertLocationsBelongToTenant(clientId: string, locationIds: string[]) {
    if (locationIds.length === 0) return;
    const owned = await prisma.stockLocation.count({
      where: { clientId, id: { in: locationIds } }
    });
    if (owned !== locationIds.length) {
      throw Object.assign(
        new Error('One of those stock locations does not belong to this account.'),
        { statusCode: 400 }
      );
    }
  }
}

export const storefrontConnectionService = new StorefrontConnectionService();

/** Connections that should receive events right now. */
export async function deliverableConnections(clientId: string) {
  return prisma.storefrontConnection.findMany({
    where: { clientId, status: { in: [StorefrontConnectionStatus.ACTIVE, StorefrontConnectionStatus.PENDING_SYNC] } },
    select: { id: true, status: true, locationIds: true }
  });
}

export { DeliveryStatus };
