/**
 * Putting a mapped Shopify order into the database, or parking it where somebody can see it.
 *
 * `mapping.ts` decides what an order MEANS; this decides where it goes. The split matters: the
 * meaning can be tested against a real payload with no database at all, and this file is then
 * only about writes, idempotency and refusals.
 *
 * The rule for every refusal here: **park, never guess and never drop.** Each reason below is a
 * decision a person has to make, and neither of the alternatives is acceptable -- guessing writes
 * a real sale against the wrong shop floor, and dropping loses money that was actually taken.
 */

import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { generateSequentialCode } from '../../utils/codeGenerator';
import { reservationService } from '../reservation.service';
import { fromMinor, toMinor } from '../pricing';
import { mapShopifyOrder, MappedOrder, ParkReason } from './mapping';

export type IngestOutcome =
  | { status: 'APPLIED'; salesOrderId: string; orderNumber: string }
  | { status: 'STALE' }
  | { status: 'PARKED'; reason: ParkReason; detail: string };

/**
 * Park an order with everything needed to replay it.
 *
 * Upserted on (shop, order, topic) so a redelivered webhook updates its row instead of adding a
 * second one -- otherwise a shop with one unmapped location accumulates a parked row per retry,
 * for days, and the panel becomes unreadable exactly when it matters.
 */
async function park(
  shopDomain: string,
  clientId: string | null,
  shopifyOrderId: string,
  topic: string,
  payload: any,
  reason: ParkReason,
  detail: string
): Promise<IngestOutcome> {
  await prisma.shopifyOrderInbox.upsert({
    where: { uq_inbox_order_topic: { shopDomain, shopifyOrderId, topic } },
    create: { shopDomain, clientId, shopifyOrderId, topic, payload, reason, detail, attempts: 1 },
    update: { reason, detail, payload, clientId, attempts: { increment: 1 }, resolvedAt: null }
  });
  console.warn(`[Shopify] order ${shopifyOrderId} from ${shopDomain} parked: ${reason} -- ${detail}`);
  return { status: 'PARKED', reason, detail };
}

/**
 * Which of OUR locations this order sold from.
 *
 * The obvious reading -- "map the order's location_id" -- is wrong for the case that matters.
 * Shopify sets `location_id` on POS orders; an ONLINE order usually has none at all, so a rule
 * that requires it would park every single web sale, which is the entire point of this phase.
 *
 * So: use the mapping when Shopify names a location. When it does not, fall back to the one
 * mapped location if there is exactly one -- unambiguous, and the common case for a shop with a
 * single shop floor. With several mapped and no location named, there is a real decision to make
 * and no safe default, so it parks and says so.
 */
async function resolveLocation(
  installationId: string,
  clientId: string,
  shopifyLocationId: string | null
): Promise<{ locationId: string } | { detail: string }> {
  const maps = await prisma.shopifyLocationMap.findMany({
    where: { installationId, clientId },
    select: { locationId: true, shopifyLocationId: true }
  });

  if (maps.length === 0) {
    return { detail: 'No Shopify location has been paired with a location here yet.' };
  }

  // 1. Shopify named one. A POS sale, and the pairing is the whole answer.
  if (shopifyLocationId) {
    const hit = maps.find(m => m.shopifyLocationId === String(shopifyLocationId));
    if (hit) return { locationId: hit.locationId };
    return { detail: `Shopify location ${shopifyLocationId} is not paired with a location here.` };
  }

  /*
   * 2. It named none, which is every web sale.
   *
   * The connection already carries the answer. StorefrontConnection.locationIds is "which
   * locations this storefront sells from", set when the merchant connected the store and used
   * to decide what stock the website is even shown -- so it is the same question, already
   * answered, and using it means an online order lands where its stock came from.
   *
   * Found by testing: pairing a second Shopify location made EVERY online order ambiguous under
   * the earlier rule, so a shop with a warehouse and a shop floor would have had all of its web
   * sales parked. That is not an edge case, it is most shops.
   */
  const connection = await prisma.storefrontConnection.findFirst({
    where: { clientId, type: 'SHOPIFY', status: { in: ['ACTIVE', 'PENDING_SYNC'] } },
    select: { locationIds: true, name: true }
  });

  const scoped = (connection?.locationIds ?? []).filter(id => maps.some(m => m.locationId === id));
  if (scoped.length === 1) return { locationId: scoped[0] };

  // 3. Nothing said which, but there is only one it could be.
  if (maps.length === 1) return { locationId: maps[0].locationId };

  return {
    detail:
      `This order names no Shopify location and ${maps.length} are paired, so there is no way to ` +
      `tell which shop it sold from. Set which location this Shopify store sells from in ` +
      `Settings > Storefront, or unpair the ones that do not sell online.`
  };
}

/**
 * The customer, or the shop's single "Online guest".
 *
 * One guest row per tenant, found by a fixed external id and created once. A row per guest order
 * would turn a year of web sales into a customer list nobody can use, and `SalesOrder.customerId`
 * is not nullable, so there has to be somebody.
 */
async function resolveCustomer(clientId: string, c: MappedOrder['customer']): Promise<string> {
  if (c.shopifyCustomerId) {
    const externalCustomerId = `shopify:${c.shopifyCustomerId}`;
    const existing = await prisma.customer.findFirst({ where: { clientId, externalCustomerId } });
    if (existing) return existing.id;

    return (await prisma.customer.create({
      data: {
        clientId,
        customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER'),
        externalCustomerId,
        name: c.name || c.email || 'Shopify customer',
        email: c.email, phone: c.phone,
        billingAddress: c.billingAddress, shippingAddress: c.shippingAddress,
        status: 'ACTIVE'
      }
    })).id;
  }

  if (c.email) {
    const existing = await prisma.customer.findFirst({ where: { clientId, email: c.email, deletedAt: null } });
    if (existing) return existing.id;

    return (await prisma.customer.create({
      data: {
        clientId,
        customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER'),
        name: c.name || c.email,
        email: c.email, phone: c.phone,
        billingAddress: c.billingAddress, shippingAddress: c.shippingAddress,
        status: 'ACTIVE'
      }
    })).id;
  }

  const GUEST = 'shopify:guest';
  const guest = await prisma.customer.findFirst({ where: { clientId, externalCustomerId: GUEST } });
  if (guest) return guest.id;

  return (await prisma.customer.create({
    data: {
      clientId,
      customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER'),
      externalCustomerId: GUEST,
      name: 'Online guest',
      customerType: 'WALK_IN',
      status: 'ACTIVE'
    }
  })).id;
}

export class ShopifyOrderIngestService {
  /**
   * One `orders/create` or `orders/updated`.
   *
   * Returns rather than throws for anything recoverable, so the webhook route can record an
   * outcome and acknowledge. Shopify retries a non-2xx for days and then unsubscribes the topic
   * entirely, which is a far worse failure than a parked order.
   */
  async ingest(shopDomain: string, payload: any, topic: string): Promise<IngestOutcome> {
    const shopifyOrderId = payload?.id === undefined || payload?.id === null ? '' : String(payload.id);
    if (!shopifyOrderId) {
      return park(shopDomain, null, 'unknown', topic, payload, 'FAILED', 'The payload has no order id.');
    }

    const installation = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain },
      select: { id: true, clientId: true, uninstalledAt: true }
    });

    if (!installation) {
      return park(shopDomain, null, shopifyOrderId, topic, payload, 'FAILED',
        'No installation exists for this shop.');
    }

    // An unclaimed install is inert by design: nobody has said whose data this is, and writing a
    // real sale into a guessed tenant is the one mistake with no way back.
    if (!installation.clientId) {
      return park(shopDomain, null, shopifyOrderId, topic, payload, 'UNCLAIMED_INSTALL',
        'Nobody has claimed this Shopify store yet, so we do not know whose sale this is.');
    }

    const clientId = installation.clientId;

    const location = await resolveLocation(
      installation.id, clientId,
      payload?.location_id === undefined || payload?.location_id === null ? null : String(payload.location_id)
    );
    if ('detail' in location) {
      return park(shopDomain, clientId, shopifyOrderId, topic, payload, 'UNMAPPED_LOCATION', location.detail);
    }

    const idMaps = await prisma.shopifyIdMap.findMany({
      where: { installationId: installation.id, clientId },
      select: { shopifyVariantId: true, variantId: true, sku: true }
    });

    const variantIds = idMaps.map(m => m.variantId);
    const costs = await prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, averageCost: true }
    });
    const costById = new Map(costs.map(c => [c.id, toMinor(c.averageCost)]));

    const variants = new Map(idMaps.map(m => [
      m.shopifyVariantId,
      { variantId: m.variantId, averageCostMinor: costById.get(m.variantId) ?? 0, sku: m.sku }
    ]));

    const { currency } = await getShopSettings(clientId);
    const mapped = mapShopifyOrder(payload, { locationId: location.locationId, currency, variants });

    if (!mapped.ok) {
      return park(shopDomain, clientId, shopifyOrderId, topic, payload, mapped.reason, mapped.detail);
    }

    try {
      const result = await this.write(clientId, mapped.order, shopifyOrderId);
      if (result.status === 'APPLIED') {
        // Whatever was waiting for this order is now settled.
        await prisma.shopifyOrderInbox.updateMany({
          where: { shopDomain, shopifyOrderId, resolvedAt: null },
          data: { resolvedAt: new Date(), resolvedBy: 'system', salesOrderId: result.salesOrderId }
        });
      }
      return result;
    } catch (error: any) {
      return park(shopDomain, clientId, shopifyOrderId, topic, payload, 'FAILED',
        String(error?.message ?? error).slice(0, 500));
    }
  }

  /** The writes. Separate so `ingest` reads as the decisions and this as the consequences. */
  private async write(clientId: string, order: MappedOrder, shopifyOrderId: string): Promise<IngestOutcome> {
    const existing = await prisma.salesOrder.findFirst({
      where: { clientId, externalOrderId: order.externalOrderId, sourceSystem: 'SHOPIFY' },
      select: { id: true, orderNumber: true, externalUpdatedAt: true, status: true }
    });

    /*
     * An older version of an order arriving after a newer one.
     *
     * Shopify redelivers and does not promise order. Without this, a retried `orders/updated`
     * from two minutes ago would overwrite the current state of the order -- and the merchant
     * would watch a shipped order go back to unfulfilled for no reason they could see.
     */
    if (existing && order.externalUpdatedAt && existing.externalUpdatedAt
        && existing.externalUpdatedAt >= order.externalUpdatedAt) {
      return { status: 'STALE' };
    }

    const customerId = await resolveCustomer(clientId, order.customer);

    if (existing) {
      await this.replaceLines(clientId, existing.id, order);
      return { status: 'APPLIED', salesOrderId: existing.id, orderNumber: existing.orderNumber };
    }

    const orderNumber = await generateSequentialCode(clientId, 'SO', 'SALES_ORDER');

    const created = await prisma.$transaction(async (tx) => {
      const so = await tx.salesOrder.create({
        data: {
          clientId,
          orderNumber,
          locationId: order.locationId,
          customerId,
          channel: 'ONLINE',
          externalOrderId: order.externalOrderId,
          sourceSystem: 'SHOPIFY',
          externalUpdatedAt: order.externalUpdatedAt,
          customerName: order.customer.name,
          customerPhone: order.customer.phone,
          shippingAddress: order.customer.shippingAddress,
          billingAddress: order.customer.billingAddress,
          // DRAFT first, then moved with the state machine once the lines exist -- an order with
          // a status but no lines is a shape nothing else in this codebase expects.
          status: 'DRAFT',
          subtotal: fromMinor(order.subtotalMinor),
          discountAmount: fromMinor(order.discountMinor),
          taxAmount: fromMinor(order.taxMinor),
          shippingAmount: fromMinor(order.shippingMinor),
          total: fromMinor(order.totalMinor)
        }
      });

      await this.writeLinesAndDiscounts(tx, so.id, order);
      return so;
    }, { timeout: 30000 });

    await this.settleStatus(clientId, created.id, order);

    console.log(`[Shopify] order ${shopifyOrderId} ingested as ${orderNumber} (${order.status})`);
    return { status: 'APPLIED', salesOrderId: created.id, orderNumber };
  }

  /** Lines, the discounts that produced them, and how each was divided. */
  private async writeLinesAndDiscounts(tx: any, salesOrderId: string, order: MappedOrder) {
    const itemIds: string[] = [];

    for (const line of order.lines) {
      const totalCostMinor = line.unitCostMinor * line.quantity;
      const item = await tx.salesOrderItem.create({
        data: {
          salesOrderId,
          variantId: line.variantId,
          quantity: line.quantity,
          listUnitPrice: fromMinor(line.listUnitPriceMinor),
          lineDiscount: fromMinor(line.lineDiscountMinor),
          allocatedDiscount: fromMinor(line.allocatedDiscountMinor),
          unitPrice: fromMinor(line.unitPriceMinor),
          unitCost: fromMinor(line.unitCostMinor),
          totalPrice: fromMinor(line.totalPriceMinor),
          totalCost: fromMinor(totalCostMinor),
          // From the NET, like every other road into this table.
          grossProfit: fromMinor(line.totalPriceMinor - totalCostMinor),
          // Shopify charged the customer. We are writing down what they paid, not deciding it.
          priceSource: 'EXTERNAL'
        }
      });
      itemIds.push(item.id);
    }

    // Nothing reads these yet -- they are Phase 2's. Written now so that an order ingested today
    // does not have to be ingested a second time to gain its breakdown later.
    for (let d = 0; d < order.discounts.length; d++) {
      const discount = order.discounts[d];
      const row = await tx.salesOrderDiscount.create({
        data: {
          salesOrderId,
          source: 'SHOPIFY',
          externalId: discount.externalId,
          title: discount.title,
          amount: fromMinor(discount.amountMinor)
        }
      });

      for (let i = 0; i < order.lines.length; i++) {
        for (const alloc of order.lines[i].allocations) {
          if (alloc.applicationIndex !== d) continue;
          await tx.salesOrderItemDiscount.create({
            data: {
              salesOrderItemId: itemIds[i],
              salesOrderDiscountId: row.id,
              amount: fromMinor(alloc.amountMinor)
            }
          });
        }
      }
    }
  }

  /** An order that already exists and has genuinely changed. */
  private async replaceLines(clientId: string, salesOrderId: string, order: MappedOrder) {
    await prisma.$transaction(async (tx) => {
      // Allocations and discounts cascade from the rows they hang off, so removing the lines
      // removes them too.
      await tx.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrderId } } });
      await tx.salesOrderDiscount.deleteMany({ where: { salesOrderId } });
      await tx.salesOrderItem.deleteMany({ where: { salesOrderId } });

      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: {
          externalUpdatedAt: order.externalUpdatedAt,
          subtotal: fromMinor(order.subtotalMinor),
          discountAmount: fromMinor(order.discountMinor),
          taxAmount: fromMinor(order.taxMinor),
          shippingAmount: fromMinor(order.shippingMinor),
          total: fromMinor(order.totalMinor),
          shippingAddress: order.customer.shippingAddress,
          billingAddress: order.customer.billingAddress
        }
      });

      await this.writeLinesAndDiscounts(tx, salesOrderId, order);
    }, { timeout: 30000 });

    await this.settleStatus(clientId, salesOrderId, order);
  }

  /**
   * Move the order to where Shopify says it is, and reserve stock if that means it is live.
   *
   * Reservation goes through reservationService, not a hand-written update, so a Shopify order
   * holds stock exactly the way a POS order does. Anything already past CONFIRMED is left alone:
   * a fulfilled order's stock was dealt with when it shipped.
   */
  private async settleStatus(clientId: string, salesOrderId: string, order: MappedOrder) {
    if (order.status === 'DRAFT') return;

    const current = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: salesOrderId },
      include: { items: true }
    });
    if (current.status !== 'DRAFT') return;

    if (order.status === 'CANCELLED') {
      await prisma.salesOrder.update({ where: { id: salesOrderId }, data: { status: 'CANCELLED' } });
      return;
    }

    await reservationService.reserveStock(
      clientId,
      current.locationId,
      current.items.map(i => ({ variantId: i.variantId, salesOrderItemId: i.id, quantity: i.quantity }))
    );

    await prisma.salesOrder.update({
      where: { id: salesOrderId },
      // CONFIRMED even when Shopify says fulfilled: the goods leaving is a separate event with
      // its own stock movement, handled by orders/fulfilled. Jumping straight to DISPATCHED here
      // would mark stock as gone without ever moving it.
      data: { status: 'CONFIRMED' }
    });
  }
}

export const shopifyOrderIngestService = new ShopifyOrderIngestService();
