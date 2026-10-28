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
import { phoneForOutsideCustomer } from '../customer.service';
import { normalisePhone } from '../../lib/phone';
import { reservationService } from '../reservation.service';
import { fromMinor, toMinor } from '../pricing';
import { registrationInForce } from '../pricing/tax';
import { allocateInvoiceNumber, SERIES } from '../invoicing/invoiceNumber';
import { mapShopifyOrder, MappedOrder, ParkReason } from './mapping';
import { gstForShopifyOrder, OrderGst, LineStanding } from './gst';
import { park, ORDER_TOPICS } from './parking';
import { tellShopGstWorthChecking } from './notices';

export type IngestOutcome =
  /** created: placed just now, rather than an order already here being brought up to date. */
  | { status: 'APPLIED'; salesOrderId: string; orderNumber: string; created?: boolean }
  | { status: 'STALE' }
  | { status: 'PARKED'; reason: ParkReason; detail: string };

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
async function resolveCustomer(clientId: string, shopDomain: string, c: MappedOrder['customer']): Promise<string> {
  if (c.shopifyCustomerId) {
    const externalCustomerId = `shopify:${c.shopifyCustomerId}`;
    const existing = await prisma.customer.findFirst({ where: { clientId, externalCustomerId } });
    if (existing) return existing.id;

    // In a transaction for the phone's lock: see phoneForOutsideCustomer.
    return prisma.$transaction(async tx => {
      const phone = await phoneForOutsideCustomer(tx, clientId, c.phone);
      return (await tx.customer.create({
        data: {
          clientId,
          customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any),
          externalCustomerId,
          // Which store they came from: shop/redact erases one store's customers, not every one.
          sourceStore: shopDomain,
          name: c.name || c.email || 'Shopify customer',
          email: c.email, phone: phone.onCustomer,
          billingAddress: c.billingAddress, shippingAddress: c.shippingAddress,
          status: 'ACTIVE'
        }
      })).id;
    }, { maxWait: 15000, timeout: 20000 });
  }

  if (c.email) {
    const existing = await prisma.customer.findFirst({ where: { clientId, email: c.email, deletedAt: null } });
    if (existing) return existing.id;

    const email = c.email;
    return prisma.$transaction(async tx => {
      const phone = await phoneForOutsideCustomer(tx, clientId, c.phone);
      return (await tx.customer.create({
        data: {
          clientId,
          customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any),
          sourceStore: shopDomain,
          name: c.name || email,
          email: c.email, phone: phone.onCustomer,
          billingAddress: c.billingAddress, shippingAddress: c.shippingAddress,
          status: 'ACTIVE'
        }
      })).id;
    }, { maxWait: 15000, timeout: 20000 });
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
      select: {
        id: true, averageCost: true, sku: true, hsnCode: true, taxRateBps: true,
        product: { select: { title: true, hsnCode: true, taxRateBps: true, taxSlabbed: true } }
      }
    });
    const costById = new Map(costs.map(c => [c.id, toMinor(c.averageCost)]));
    // The tax standing of each of our variants -- the variant's own code wins, as on the till.
    const standingById = new Map<string, LineStanding>(costs.map(c => [c.id, {
      label: `${c.product.title} (${c.sku})`,
      hsnCode: c.hsnCode ?? c.product.hsnCode ?? null,
      taxRateBps: c.taxRateBps ?? c.product.taxRateBps ?? null,
      taxSlabbed: Boolean(c.product.taxSlabbed)
    }]));

    const variants = new Map(idMaps.map(m => [
      m.shopifyVariantId,
      { variantId: m.variantId, averageCostMinor: costById.get(m.variantId) ?? 0, sku: m.sku }
    ]));

    const { currency } = await getShopSettings(clientId);
    const mapped = mapShopifyOrder(payload, { locationId: location.locationId, currency, variants });

    if (!mapped.ok) {
      return park(shopDomain, clientId, shopifyOrderId, topic, payload, mapped.reason, mapped.detail);
    }

    // ScaleEzy's own GST on it -- never Shopify's (owner's rule, 26 Oct 2026).
    const gstSettings = await prisma.clientSettings.findUnique({
      where: { clientId }, select: { gstRegistration: true, gstStateCode: true, gstNumber: true }
    });
    const gst = gstForShopifyOrder(
      mapped.order,
      mapped.order.lines.map(l => standingById.get(l.variantId) ?? { label: 'An item', hsnCode: null, taxRateBps: null, taxSlabbed: false }),
      { registration: registrationInForce(gstSettings?.gstRegistration, gstSettings?.gstNumber), stateCode: gstSettings?.gstStateCode ?? null }
    );
    if (gst.crossCheck) console.log(`[Shopify] order ${shopifyOrderId}: ${gst.crossCheck}`);

    try {
      const result = await this.write(clientId, shopDomain, mapped.order, shopifyOrderId, gst);
      if (result.status === 'APPLIED') {
        /*
         * The ORDER rows waiting for this order are now settled -- and only those.
         *
         * This used to resolve every open row for the order, which included a parked fulfilment
         * or refund that had not been applied yet. They were marked done without ever running:
         * the order's stock stayed reserved after it had shipped, and its refund never happened.
         * Follow-ups are applied by the inbox service once the order exists.
         */
        await prisma.shopifyOrderInbox.updateMany({
          where: { shopDomain, shopifyOrderId, topic: { in: ORDER_TOPICS }, resolvedAt: null },
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
  private async write(clientId: string, shopDomain: string, order: MappedOrder, shopifyOrderId: string, gst: OrderGst): Promise<IngestOutcome> {
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

    const customerId = await resolveCustomer(clientId, shopDomain, order.customer);

    if (existing) {
      await this.bringUpToDate(clientId, existing.id, order, gst);
      await this.afterwards(clientId, existing.id, order, shopifyOrderId);
      return { status: 'APPLIED', salesOrderId: existing.id, orderNumber: existing.orderNumber };
    }

    const orderNumber = await generateSequentialCode(clientId, 'SO', 'SALES_ORDER');

    let created;
    try {
      created = await this.createOrder(clientId, shopDomain, orderNumber, customerId, order, gst);
    } catch (error: any) {
      /*
       * Somebody else placed it first.
       *
       * `orders/create` and `orders/updated` for the same order routinely arrive within the same
       * second, and a merchant can press Retry while a webhook is mid-flight. Both pass the
       * existence check above; the unique key on (client, externalOrderId, sourceSystem) lets
       * exactly one write. The loser used to be parked as FAILED with a database error in it --
       * a scary row in the inbox for an order that had in fact been placed perfectly.
       */
      if (error?.code === 'P2002') {
        const winner = await prisma.salesOrder.findFirst({
          where: { clientId, externalOrderId: order.externalOrderId, sourceSystem: 'SHOPIFY' },
          select: { id: true, orderNumber: true }
        });
        if (winner) return { status: 'APPLIED', salesOrderId: winner.id, orderNumber: winner.orderNumber };
      }
      throw error;
    }

    await this.settleStatus(clientId, created.id, order);
    await this.afterwards(clientId, created.id, order, shopifyOrderId);
    if (gst.warnings.length) await tellShopGstWorthChecking(clientId, created.id, gst.warnings);

    console.log(`[Shopify] order ${shopifyOrderId} ingested as ${orderNumber} (${order.status})`);
    return { status: 'APPLIED', salesOrderId: created.id, orderNumber, created: true };
  }

  private async createOrder(clientId: string, shopDomain: string, orderNumber: string, customerId: string, order: MappedOrder, gst: OrderGst) {
    return prisma.$transaction(async (tx) => {
      const so = await tx.salesOrder.create({
        data: {
          clientId,
          orderNumber,
          locationId: order.locationId,
          customerId,
          channel: 'ONLINE',
          externalOrderId: order.externalOrderId,
          sourceSystem: 'SHOPIFY',
          sourceStore: shopDomain,
          externalUpdatedAt: order.externalUpdatedAt,
          customerName: order.customer.name,
          // The order's copy in the one stored form when it is a real number, as typed otherwise.
          customerPhone: (() => { const r = normalisePhone(order.customer.phone); return r.ok ? r.value : (order.customer.phone || null); })(),
          shippingAddress: order.customer.shippingAddress,
          billingAddress: order.customer.billingAddress,
          // DRAFT first, then moved with the state machine once the lines exist -- an order with
          // a status but no lines is a shape nothing else in this codebase expects.
          status: 'DRAFT',
          subtotal: fromMinor(order.subtotalMinor),
          discountAmount: fromMinor(order.discountMinor),
          // OUR GST, inside the total like the till's -- never added to it. The total is what
          // Shopify charged.
          taxAmount: fromMinor(gst.taxMinor),
          shippingAmount: fromMinor(order.shippingMinor),
          total: fromMinor(order.totalMinor),
          // Fixed at sale time: a bill keeps the kind it was issued under.
          documentKind: gst.documentKind,
          placeOfSupplyStateCode: gst.placeOfSupplyStateCode,
          interState: gst.interState,
          payOnDelivery: order.payment.cod
        }
      });

      await this.writeLinesAndDiscounts(tx, so.id, order, gst);
      return so;
    }, { timeout: 30000 });
  }

  /** Lines, the discounts that produced them, and how each was divided. */
  private async writeLinesAndDiscounts(tx: any, salesOrderId: string, order: MappedOrder, gst: OrderGst) {
    const itemIds: string[] = [];

    for (let li = 0; li < order.lines.length; li++) {
      const line = order.lines[li];
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
          priceSource: 'EXTERNAL',
          // ...but the GST on it is ours, frozen now and never looked up again.
          ...lineTaxColumns(gst.lines[li])
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

  /**
   * An order that already exists and has genuinely changed.
   *
   * Usually only its state has: paid at last (cash on delivery), shipped, an address corrected.
   * Then the lines are left exactly where they are -- deleting them used to delete their stock
   * reservations with them (the rows cascade) while the shop's reserved count stayed up, so a COD
   * order marked paid would have locked its pieces away for good, and a shipped one could not be
   * updated at all (its dispatch rows hold on to the lines). Only the money columns and the GST
   * are refreshed in place.
   *
   * When Shopify's lines really did change (an order edit), they are rewritten -- with the stock
   * released first and held again after, so the reserved count follows the new lines.
   */
  private async bringUpToDate(clientId: string, salesOrderId: string, order: MappedOrder, gst: OrderGst) {
    const current = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: salesOrderId },
      select: { status: true, documentKind: true, locationId: true, items: { orderBy: { createdAt: 'asc' }, select: { id: true, variantId: true, quantity: true, listUnitPrice: true, totalPrice: true } } }
    });

    const header = {
      externalUpdatedAt: order.externalUpdatedAt,
      subtotal: fromMinor(order.subtotalMinor),
      discountAmount: fromMinor(order.discountMinor),
      taxAmount: fromMinor(gst.taxMinor),
      shippingAmount: fromMinor(order.shippingMinor),
      total: fromMinor(order.totalMinor),
      shippingAddress: order.customer.shippingAddress,
      billingAddress: order.customer.billingAddress,
      placeOfSupplyStateCode: gst.placeOfSupplyStateCode,
      interState: gst.interState,
      payOnDelivery: order.payment.cod,
      // An order placed before kinds were stored takes one now; one that has a kind keeps it.
      ...(current.documentKind ? {} : { documentKind: gst.documentKind })
    };

    const same = current.items.length === order.lines.length && order.lines.every((l, i) => {
      const it = current.items[i];
      return it.variantId === l.variantId && it.quantity === l.quantity
        && toMinor(it.listUnitPrice) === l.listUnitPriceMinor && toMinor(it.totalPrice) === l.totalPriceMinor;
    });

    if (same) {
      await prisma.$transaction(async (tx) => {
        await tx.salesOrder.update({ where: { id: salesOrderId }, data: header });
        for (let i = 0; i < current.items.length; i++) {
          await tx.salesOrderItem.update({ where: { id: current.items[i].id }, data: lineTaxColumns(gst.lines[i]) });
        }
      }, { timeout: 30000 });
    } else {
      const held = current.status === 'CONFIRMED';
      await prisma.$transaction(async (tx) => {
        if (held) {
          for (const it of current.items) await reservationService.releaseReservation(clientId, it.id, tx);
        }
        // Allocations and discounts cascade from the rows they hang off, so removing the lines
        // removes them too.
        await tx.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrderId } } });
        await tx.salesOrderDiscount.deleteMany({ where: { salesOrderId } });
        await tx.salesOrderItem.deleteMany({ where: { salesOrderId } });

        await tx.salesOrder.update({ where: { id: salesOrderId }, data: header });

        await this.writeLinesAndDiscounts(tx, salesOrderId, order, gst);

        if (held) {
          const items = await tx.salesOrderItem.findMany({ where: { salesOrderId }, select: { id: true, variantId: true, quantity: true } });
          await reservationService.reserveStock(
            clientId, current.locationId,
            items.map(i => ({ variantId: i.variantId, salesOrderItemId: i.id, quantity: i.quantity })),
            tx, { allowOversell: true }
          );
        }
      }, { timeout: 30000 });
    }

    await this.settleStatus(clientId, salesOrderId, order);
  }

  /** Once the order stands: its invoice number, and the money Shopify says has come in. */
  private async afterwards(clientId: string, salesOrderId: string, order: MappedOrder, shopifyOrderId: string) {
    await this.issueInvoiceNumber(clientId, salesOrderId);
    await this.recordPayment(clientId, salesOrderId, order, shopifyOrderId);
  }

  /**
   * The shop's own number for the bill, from its Shopify series (SHP/2026-27/00001).
   *
   * Only for a shop that issues a numbered GST document -- a tax invoice (REGULAR) or a bill of
   * supply (COMPOSITION); an unregistered shop's plain receipt needs none. Taken once the order is
   * real (held or further), never for a draft that may never be paid, and taken inside the same
   * transaction that writes it onto the order, so the series has no holes.
   */
  private async issueInvoiceNumber(clientId: string, salesOrderId: string) {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; document_kind: string | null; invoice_number: number | null }[]>`
        SELECT status::text AS status, document_kind, invoice_number FROM sales_orders WHERE id = ${salesOrderId} FOR UPDATE`;
      const o = rows[0];
      if (!o || o.invoice_number != null) return;
      if (o.document_kind !== 'TAX_INVOICE' && o.document_kind !== 'BILL_OF_SUPPLY') return;
      if (o.status === 'DRAFT' || o.status === 'CANCELLED') return;
      const n = await allocateInvoiceNumber(tx as any, clientId, SERIES.SHOPIFY);
      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: { invoiceSeries: n.series, invoiceNumber: n.number, invoiceFinancialYear: n.financialYear }
      });
    }, { timeout: 30000 });
  }

  /**
   * The money, as Shopify reports it: what has been paid so far, recorded once.
   *
   * Shopify sends the absolute figure ("paid 4,200 of 4,200"), so only the part not yet recorded
   * is written, keyed by that figure: a redelivered webhook, or orders/create and orders/updated
   * arriving together, hit the same key and the database lets one through. The order row is
   * locked while it is worked out, so two different figures arriving at once cannot each add
   * their own share on top of nothing.
   *
   * Cash on delivery records nothing until Shopify says the cash was collected; then one CASH row.
   */
  private async recordPayment(clientId: string, salesOrderId: string, order: MappedOrder, shopifyOrderId: string) {
    const received = order.payment.receivedMinor;
    if (received <= 0) return;
    const prefix = shopifyPaidKeyPrefix(clientId, shopifyOrderId);

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${salesOrderId} FOR UPDATE`;
        const before = await tx.salesOrderPayment.findMany({
          where: { salesOrderId, kind: 'PAYMENT', onceKey: { startsWith: prefix } }, select: { amount: true }
        });
        const recorded = before.reduce((s, p) => s + toMinor(p.amount), 0);
        if (received <= recorded) return;
        const so = await tx.salesOrder.findUniqueOrThrow({ where: { id: salesOrderId }, select: { locationId: true } });
        await tx.salesOrderPayment.create({
          data: {
            clientId, salesOrderId, locationId: so.locationId,
            kind: 'PAYMENT', method: order.payment.method,
            amount: fromMinor(received - recorded),
            reference: order.payment.gateway ? `Shopify: ${order.payment.gateway}`.slice(0, 120) : 'Shopify',
            receivedAt: order.externalUpdatedAt ?? new Date(),
            onceKey: `${prefix}${received}`
          }
        });
      }, { timeout: 30000 });
    } catch (error: any) {
      if (error?.code === 'P2002') return; // the same figure, recorded by the other delivery
      throw error;
    }
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

/** The onceKey prefix of every payment row a Shopify order's money made. */
export const shopifyPaidKeyPrefix = (clientId: string, shopifyOrderId: string) => `SHOPIFY:${clientId}:${shopifyOrderId}:PAID:`;

/** One line's frozen GST as the sales_order_items columns hold it (rupees, Decimal). */
function lineTaxColumns(l: OrderGst['lines'][number] | undefined) {
  const d = (v: number | null | undefined) => (v == null ? null : fromMinor(v));
  return {
    hsnCode: l?.hsnCode ?? null,
    taxRateBps: l?.taxRateBps ?? null,
    taxableValue: d(l?.taxableMinor),
    cgst: d(l?.cgstMinor),
    sgst: d(l?.sgstMinor),
    igst: d(l?.igstMinor)
  };
}
