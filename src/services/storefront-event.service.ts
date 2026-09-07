import { Prisma, StorefrontEventType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { storefrontCatalogueService } from './storefront-catalogue.service';

/**
 * Raising an event, and fanning it out to every storefront that should hear it.
 *
 * Two rules this file exists to enforce:
 *
 * ONLY CREATE WORK THAT HAS A DESTINATION. Most tenants will never connect a storefront. If a
 * shop has no connection, no event and no delivery is written at all. The previous outbox wrote
 * a row for every stock movement of all 21 tenants regardless, none of which could ever be
 * delivered, and reached 747 undeliverable rows in a fortnight.
 *
 * A DELIVERY IS PER CONNECTION. One event, one delivery row per destination, each with its own
 * status and attempts. A single status column on the event can only describe one destination,
 * which is why the old design could not represent "the website has it, the marketplace has not"
 * -- and why its rows ended up stranded.
 *
 * Everything here is best-effort with respect to its caller. Raising an event must never fail
 * a stock movement: the movement is the real work and the ledger is the source of truth, so a
 * storefront that misses a notification recovers through incremental sync rather than by us
 * refusing to let a shopkeeper receive stock.
 */

export class StorefrontEventService {
  /**
   * Stock changed for a variant.
   *
   * The event carries what each connection's own scope says is true -- a warehouse-only
   * storefront and a shop-only storefront are told different numbers about the same movement,
   * because for them different numbers ARE true.
   */
  async stockUpdated(clientId: string, variantId: string, previousQuantity?: number) {
    await this.emitPerConnection(clientId, async (connection) => {
      const view = await storefrontCatalogueService.variantStockForScope(
        { clientId, locationIds: connection.locationIds }, variantId
      );
      // Not published, archived or binned: this storefront has no business knowing.
      if (!view || !view.eligible) return null;

      return {
        eventType: StorefrontEventType.STOCK_UPDATED,
        sku: view.sku,
        productCode: view.productCode,
        variantId,
        payload: {
          sku: view.sku,
          productCode: view.productCode,
          stock: view.stock,
          previousQuantity: previousQuantity ?? null
        }
      };
    });
  }

  /** A product became visible, changed, or was withdrawn. */
  async productChanged(
    clientId: string,
    productId: string,
    eventType: StorefrontEventType
  ) {
    const product = await prisma.product.findFirst({
      where: { id: productId, clientId },
      select: { productCode: true }
    });
    if (!product) return;

    await this.emitPerConnection(clientId, async (connection) => {
      // Unpublishing is the one case that must be sent even though the product is no longer
      // eligible: a storefront that is never told simply keeps selling it.
      if (eventType === StorefrontEventType.PRODUCT_UNPUBLISHED) {
        return {
          eventType,
          productCode: product.productCode,
          sku: null,
          variantId: null,
          payload: { productCode: product.productCode }
        };
      }

      const full = await storefrontCatalogueService.getProduct(
        { clientId, locationIds: connection.locationIds }, product.productCode
      );
      if (!full) return null;

      return {
        eventType,
        productCode: product.productCode,
        sku: null,
        variantId: null,
        payload: { product: full }
      };
    });
  }

  /**
   * Availability was toggled for a variant at a location -- the explicit "show this online"
   * switch, which previously emitted nothing at all and so never reached any storefront.
   */
  async availabilityChanged(clientId: string, variantId: string, locationId: string) {
    await this.emitPerConnection(clientId, async (connection) => {
      // A connection that does not sell from this location is unaffected by the change.
      if (connection.locationIds.length > 0 && !connection.locationIds.includes(locationId)) {
        return null;
      }

      const view = await storefrontCatalogueService.variantStockForScope(
        { clientId, locationIds: connection.locationIds }, variantId
      );
      if (!view || !view.eligible) return null;

      return {
        eventType: StorefrontEventType.AVAILABILITY_CHANGED,
        sku: view.sku,
        productCode: view.productCode,
        variantId,
        locationId,
        payload: { sku: view.sku, productCode: view.productCode, stock: view.stock }
      };
    });
  }

  /**
   * Builds one event per connection and queues a delivery for each.
   *
   * Per connection rather than one shared event, because the body genuinely differs: scope
   * decides the stock and the price, so there is no single correct payload to share. The cost
   * is one row per destination, which is what the delivery table is for anyway.
   */
  private async emitPerConnection(
    clientId: string,
    build: (connection: { id: string; locationIds: string[] }) => Promise<{
      eventType: StorefrontEventType;
      sku: string | null;
      productCode: string | null;
      variantId?: string | null;
      locationId?: string | null;
      // A plain object rather than Prisma.InputJsonValue: that type demands an index
      // signature, which a declared interface such as StorefrontProduct does not have, so
      // typing it here would force every payload shape to be anonymous. It is serialisable by
      // construction -- everything in it came out of a database read -- and is narrowed once,
      // at the create below.
      payload: object;
    } | null>
  ) {
    try {
      const connections = await prisma.storefrontConnection.findMany({
        where: { clientId, status: { in: ['ACTIVE', 'PENDING_SYNC'] } },
        select: { id: true, locationIds: true }
      });

      // No destination, no work. This single check is what stops the table growing without
      // bound for the great majority of tenants who never connect anything.
      if (connections.length === 0) return;

      for (const connection of connections) {
        const built = await build(connection);
        if (!built) continue;

        await prisma.storefrontEvent.create({
          data: {
            clientId,
            eventType: built.eventType,
            sku: built.sku,
            productCode: built.productCode,
            variantId: built.variantId ?? null,
            locationId: built.locationId ?? null,
            payload: built.payload as Prisma.InputJsonObject,
            deliveries: {
              create: {
                connectionId: connection.id,
                clientId,
                status: 'PENDING',
                nextAttemptAt: new Date()
              }
            }
          }
        });
      }
    } catch (error) {
      // Deliberately swallowed, and deliberately logged. A storefront notification must never
      // be able to fail the stock movement that caused it -- the movement is the real work, the
      // ledger is the truth, and a missed notification is recoverable through incremental sync.
      console.error('[StorefrontEvents] Could not raise event; the movement itself is unaffected.', error);
    }
  }
}

export const storefrontEventService = new StorefrontEventService();
