import { prisma } from '../../lib/prisma';
import { generateCredential } from '../../utils/storefrontCredential';
import { POS_BASE_URL, POS_ONLY } from '../../utils/posConnection';

/**
 * Till keys: what an owner makes in Settings → POS (billing counter) and pastes into the POS.
 *
 * A till key is a StorefrontConnection marked as a till (see utils/posConnection), scoped to the
 * ONE stock location the counter sells from. It is kept apart from website keys on purpose:
 *   - it is made with no website address (the website form insists on a public one);
 *   - it is never sent stock and price changes (the event fan-out is websites-only);
 *   - it opens /pos/v1 and nothing else, and a website key cannot open /pos/v1.
 *
 * The key itself is shown once, at creation or replacement. Only its hash is stored.
 */

const fault = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

async function requireTill(clientId: string, id: string) {
  const till = await prisma.storefrontConnection.findFirst({ where: { id, clientId, ...POS_ONLY } });
  if (!till) throw fault('That till is not connected to this shop.', 404);
  return till;
}

export const posConnectionService = {
  /** Every till not disconnected, with where it sells from and when a bill last came in from there. */
  async list(clientId: string) {
    const tills = await prisma.storefrontConnection.findMany({
      where: { clientId, ...POS_ONLY, status: { not: 'REVOKED' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, status: true, credentialPrefix: true, locationIds: true, createdAt: true, updatedAt: true }
    });
    const locationIds = [...new Set(tills.flatMap(t => t.locationIds))];
    const [locations, lastBills] = await Promise.all([
      prisma.stockLocation.findMany({ where: { clientId, id: { in: locationIds } }, select: { id: true, name: true } }),
      /*
       * Bills are queued per shop and location, not per key -- the same bill must still settle if
       * the key is replaced mid-flight -- so "last bill" is per location. Two tills at one
       * location share it, which the screen says in so many words.
       */
      locationIds.length
        ? prisma.posInboundEvent.groupBy({
          by: ['locationId'], where: { clientId, locationId: { in: locationIds } }, _max: { receivedAt: true }
        })
        : Promise.resolve([] as { locationId: string; _max: { receivedAt: Date | null } }[])
    ]);
    const nameOf = new Map(locations.map(l => [l.id, l.name]));
    const lastAt = new Map(lastBills.map(b => [b.locationId, b._max.receivedAt]));
    return tills.map(t => {
      const locationId = t.locationIds[0] ?? null;
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        keyPrefix: t.credentialPrefix,
        locationId,
        locationName: locationId ? nameOf.get(locationId) ?? 'A location that no longer exists' : null,
        createdAt: t.createdAt,
        lastBillAt: locationId ? lastAt.get(locationId) ?? null : null
      };
    });
  },

  /** A new till key for one location. Returns the only readable copy of the key there will be. */
  async create(clientId: string, input: { locationId: string; name?: string }) {
    const location = await prisma.stockLocation.findFirst({
      where: { id: input.locationId, clientId },
      select: { id: true, name: true, active: true }
    });
    if (!location) throw fault('Choose a stock location from this shop.');
    if (!location.active) throw fault(`${location.name} is switched off. Switch it on in Stock locations first.`);

    const name = (input.name ?? '').trim() || `${location.name} counter`;
    const credential = generateCredential();
    const till = await prisma.storefrontConnection.create({
      data: {
        clientId,
        name: name.slice(0, 80),
        type: 'GENERIC',
        baseUrl: POS_BASE_URL,
        credentialHash: credential.hash,
        credentialPrefix: credential.prefix,
        locationIds: [location.id],
        // A till has nothing to sync first: it asks for the catalogue itself.
        status: 'ACTIVE'
      },
      select: { id: true, name: true, credentialPrefix: true }
    });
    return { id: till.id, name: till.name, keyPrefix: till.credentialPrefix, locationName: location.name, key: credential.plaintext };
  },

  /** A new key; the old one stops working the moment this returns. Accepted bills are untouched. */
  async replaceKey(clientId: string, id: string) {
    const till = await requireTill(clientId, id);
    if (till.status === 'REVOKED') throw fault('That till was disconnected. Connect it again instead.');
    const credential = generateCredential();
    await prisma.storefrontConnection.update({
      where: { id },
      data: { credentialHash: credential.hash, credentialPrefix: credential.prefix, status: 'ACTIVE' }
    });
    return { id, name: till.name, keyPrefix: credential.prefix, key: credential.plaintext };
  },

  /** Disconnect for good. The row stays (history), the key never works again. */
  async disconnect(clientId: string, id: string) {
    await requireTill(clientId, id);
    await prisma.storefrontConnection.update({ where: { id }, data: { status: 'REVOKED' } });
    return { id, status: 'REVOKED' as const };
  }
};
