/**
 * Which Shopify location is which of ours.
 *
 * Until this existed, nothing in the application could create a ShopifyLocationMap. Order
 * ingestion required one, so in production every Shopify sale would have parked with "No Shopify
 * location has been paired" and there was no screen on which a merchant could pair one. Phase 1
 * worked in its test suite -- which wrote the map by hand -- and could not have worked for a shop.
 *
 * One-to-one, as the schema already insists: a Shopify location is one shop floor here, and one
 * shop floor here is one Shopify location. A many-to-one pairing would make "where did this
 * stock go" unanswerable the first time a POS sale came in.
 */

import { prisma } from '../../lib/prisma';
import { badRequest, notFound, conflict } from '../../utils/httpError';
import { ShopifyAdminApi, activeInstallation, numericShopifyId } from './adminApi';

const LOCATIONS_QUERY = `
  query Locations($after: String) {
    locations(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id name isActive fulfillsOnlineOrders address { city } }
    }
  }
`;

export interface ShopifyLocation {
  shopifyLocationId: string;
  name: string;
  city: string | null;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
}

export async function fetchShopifyLocations(api: ShopifyAdminApi): Promise<ShopifyLocation[]> {
  const out: ShopifyLocation[] = [];
  let after: string | null = null;

  // A store with more than 2,000 locations does not exist; the bound is there so a pagination
  // bug can never become an infinite loop against somebody's store.
  for (let page = 0; page < 20; page++) {
    const data: any = await api.graphql(LOCATIONS_QUERY, { after });
    const conn = data?.locations;
    for (const node of conn?.nodes ?? []) {
      const id = numericShopifyId(node?.id);
      if (!id) continue;
      out.push({
        shopifyLocationId: id,
        name: String(node.name ?? `Location ${id}`),
        city: node.address?.city ?? null,
        isActive: node.isActive !== false,
        fulfillsOnlineOrders: node.fulfillsOnlineOrders === true
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

export class ShopifyLocationPairingService {
  /**
   * Both lists, side by side, with the current pairings.
   *
   * `stalePairings` are maps pointing at a Shopify location the store no longer has. Shown rather
   * than silently deleted: an order for that location will still park, and the merchant needs to
   * see why rather than find the pairing quietly gone.
   */
  async overview(clientId: string, api: ShopifyAdminApi) {
    const installation = await activeInstallation(clientId);
    const [shopify, ours, maps] = await Promise.all([
      fetchShopifyLocations(api),
      prisma.stockLocation.findMany({
        where: { clientId, active: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' }
      }),
      prisma.shopifyLocationMap.findMany({
        where: { clientId, installationId: installation.id },
        select: { shopifyLocationId: true, locationId: true }
      })
    ]);

    const ourById = new Map(ours.map(l => [l.id, l]));
    const pairedTo = new Map(maps.map(m => [m.shopifyLocationId, m.locationId]));
    const known = new Set(shopify.map(l => l.shopifyLocationId));

    return {
      shopDomain: installation.shopDomain,
      shopifyLocations: shopify.map(l => {
        const locationId = pairedTo.get(l.shopifyLocationId) ?? null;
        return { ...l, pairedWith: locationId ? (ourById.get(locationId) ?? { id: locationId, code: null, name: 'An inactive location' }) : null };
      }),
      ourLocations: ours,
      stalePairings: maps
        .filter(m => !known.has(m.shopifyLocationId))
        .map(m => ({ shopifyLocationId: m.shopifyLocationId, pairedWith: ourById.get(m.locationId) ?? null }))
    };
  }

  /**
   * Pair a Shopify location with one of ours, or unpair it (`locationId: null`).
   *
   * The Shopify location is checked against the store itself, not taken on trust: a pairing for
   * an id the store does not have is a pairing no order will ever use, and the merchant would
   * believe the problem fixed.
   */
  async pair(clientId: string, shopifyLocationIdInput: string, locationId: string | null, api: ShopifyAdminApi) {
    const installation = await activeInstallation(clientId);
    const shopifyLocationId = numericShopifyId(shopifyLocationIdInput);
    if (!shopifyLocationId) throw badRequest('That is not a Shopify location.');

    if (locationId === null) {
      const { count } = await prisma.shopifyLocationMap.deleteMany({
        where: { clientId, installationId: installation.id, shopifyLocationId }
      });
      return { unpaired: count > 0 };
    }

    const shopify = await fetchShopifyLocations(api);
    const theirs = shopify.find(l => l.shopifyLocationId === shopifyLocationId);
    if (!theirs) throw notFound(`${installation.shopDomain} has no such location. Refresh the list.`);

    const ours = await prisma.stockLocation.findFirst({
      where: { id: locationId, clientId },
      select: { id: true, name: true, active: true }
    });
    if (!ours) throw notFound('That location does not exist here.');
    if (!ours.active) throw badRequest(`${ours.name} is inactive. Reactivate it before pairing it with Shopify.`);

    // Ours already paired with a DIFFERENT Shopify location. Refused by name rather than by the
    // unique key's error, and never silently re-pointed: moving it would change where every
    // future order from that other Shopify location lands.
    const taken = await prisma.shopifyLocationMap.findFirst({
      where: { installationId: installation.id, locationId, NOT: { shopifyLocationId } },
      select: { shopifyLocationId: true }
    });
    if (taken) {
      const other = shopify.find(l => l.shopifyLocationId === taken.shopifyLocationId);
      throw conflict(
        `${ours.name} is already paired with Shopify's ${other?.name ?? `location ${taken.shopifyLocationId}`}. ` +
        `Unpair that first.`
      );
    }

    try {
      await prisma.shopifyLocationMap.upsert({
        where: { uq_shopify_location_theirs: { installationId: installation.id, shopifyLocationId } },
        create: { installationId: installation.id, clientId, locationId, shopifyLocationId },
        update: { locationId }
      });
    } catch (error: any) {
      // Two people pairing at once, both passing the check above. The key decides; say so.
      if (error?.code === 'P2002') {
        throw conflict(`${ours.name} was just paired with another Shopify location. Refresh and try again.`);
      }
      throw error;
    }

    return { paired: { shopifyLocationId, shopifyName: theirs.name, locationId: ours.id, locationName: ours.name } };
  }
}

export const shopifyLocationPairingService = new ShopifyLocationPairingService();
