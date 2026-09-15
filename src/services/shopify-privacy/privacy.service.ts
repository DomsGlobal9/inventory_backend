import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { personalPartsOf, scrubShopifyPayload } from './scrub';

/**
 * Shopify's three privacy requests, answered.
 *
 *   customers/data_request   a customer asked the store what it holds about them. Shopify expects
 *                            the APP to hand that to the merchant, who answers the customer. We
 *                            record the request and let the merchant export it from Settings.
 *   customers/redact         a customer asked to be erased (sent 10 days after the request, or
 *                            straight away if they never ordered). Their personal details go from
 *                            the customer record, the copies on their orders, and the webhook
 *                            bodies kept for replay. The orders, stock and money stay: the shop
 *                            still sold those sarees, and its books must still add up.
 *   shop/redact              sent 48 hours after a store uninstalls the app. That store's
 *                            customers are erased as above, its parked messages deleted, and the
 *                            installation removed.
 *
 * Every request becomes a row first, then is worked. The webhook has already been acknowledged by
 * then, so a failure cannot be retried by Shopify -- the row is what lets housekeeping try again,
 * and it holds only identifiers, which is all the work needs.
 */

export const PRIVACY_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;
export type PrivacyTopic = typeof PRIVACY_TOPICS[number];
export const isPrivacyTopic = (topic: string): topic is PrivacyTopic =>
  (PRIVACY_TOPICS as readonly string[]).includes(topic);

/** What an erased customer is called. Still a row, because their orders still point at it. */
export const ERASED_NAME = 'Erased customer';

const idOf = (v: unknown): string | null =>
  v === undefined || v === null || v === '' ? null : String(v);
const idsOf = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(idOf).filter((x): x is string => !!x))] : [];

type Scope = {
  clientId: string | null;
  shopDomain: string;
  shopifyCustomerId: string | null;
  shopifyOrderIds: string[];
};

export class ShopifyPrivacyService {
  /**
   * A privacy webhook, recorded and then handled. Returns the outcome for the webhook receipt.
   *
   * The (webhook, topic) key makes a second delivery a no-op; the receipt table already stops
   * that, and this stops it again should anything ever call in twice.
   */
  async receive(topic: PrivacyTopic, shopDomain: string, webhookId: string, payload: any): Promise<string> {
    const installation = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain }, select: { clientId: true }
    });

    const request = await prisma.shopifyPrivacyRequest.upsert({
      where: { uq_privacy_request_webhook: { webhookId, topic } },
      create: {
        shopDomain,
        clientId: installation?.clientId ?? null,
        topic,
        webhookId,
        shopifyCustomerId: idOf(payload?.customer?.id),
        shopifyRequestId: idOf(payload?.data_request?.id),
        shopifyOrderIds: idsOf(topic === 'customers/redact' ? payload?.orders_to_redact : payload?.orders_requested),
        status: 'RECEIVED'
      },
      update: {}
    });

    if (request.status !== 'RECEIVED' && request.status !== 'FAILED') return 'DUPLICATE';
    return this.work(request.id);
  }

  /**
   * Do what a recorded request asks. Safe to run again on a request that failed part-way: every
   * step is "make it so", not "change it by".
   */
  async work(requestId: string): Promise<string> {
    const request = await prisma.shopifyPrivacyRequest.findUniqueOrThrow({ where: { id: requestId } });

    try {
      switch (request.topic) {
        case 'customers/data_request': {
          const scope = await this.scopeOf(request);
          const found = await this.gather(scope);
          const summary = {
            customers: found.customers.length,
            orders: found.orders.length,
            shopifyMessages: found.inbox.length
          };
          const nothing = summary.customers + summary.orders + summary.shopifyMessages === 0;
          await prisma.shopifyPrivacyRequest.update({
            where: { id: request.id },
            data: {
              clientId: scope.clientId,
              summary,
              status: nothing ? 'COMPLETED' : 'WAITING_FOR_MERCHANT',
              detail: nothing
                ? 'Nothing is held about this customer, so there is nothing to send them.'
                : 'Export what is held and send it to the customer.',
              completedAt: nothing ? new Date() : null
            }
          });
          return 'APPLIED';
        }

        case 'customers/redact': {
          const scope = await this.scopeOf(request);
          const summary = await this.eraseCustomer(scope);
          await prisma.shopifyPrivacyRequest.update({
            where: { id: request.id },
            data: {
              clientId: scope.clientId, summary, status: 'COMPLETED', completedAt: new Date(),
              detail: summary.customersKept > 0
                ? 'Erased. A customer this shop also knows outside Shopify was kept; only the Shopify orders were cleared.'
                : 'Erased.'
            }
          });
          return 'APPLIED';
        }

        case 'shop/redact': {
          const result = await this.eraseShop(request.shopDomain);
          await prisma.shopifyPrivacyRequest.update({
            where: { id: request.id },
            data: {
              clientId: result.clientId ?? request.clientId,
              summary: result.summary ?? undefined,
              status: result.skipped ? 'SKIPPED' : 'COMPLETED',
              detail: result.detail,
              completedAt: new Date()
            }
          });
          if (result.skipped) console.error(`[Shopify] shop/redact for ${request.shopDomain} skipped: ${result.detail}`);
          return result.skipped ? 'IGNORED' : 'APPLIED';
        }

        default:
          return 'IGNORED';
      }
    } catch (error: any) {
      await prisma.shopifyPrivacyRequest.update({
        where: { id: request.id },
        data: { status: 'FAILED', detail: String(error?.message ?? error).slice(0, 500) }
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Requests that did not finish -- the process died, or the database refused -- tried again.
   * Shopify allows 30 days; housekeeping runs every few hours.
   */
  async retryUnfinished(olderThanMs = 10 * 60 * 1000) {
    const stuck = await prisma.shopifyPrivacyRequest.findMany({
      where: { status: { in: ['RECEIVED', 'FAILED'] }, updatedAt: { lt: new Date(Date.now() - olderThanMs) } },
      select: { id: true },
      take: 50
    });
    let done = 0;
    for (const { id } of stuck) {
      try { await this.work(id); done++; } catch (error) {
        console.error(`[Shopify] privacy request ${id} failed again`, error);
      }
    }
    return done;
  }

  /** A store has been claimed: requests that arrived while it belonged to nobody now have an owner. */
  async attachClaimed(shopDomain: string, clientId: string) {
    const { count } = await prisma.shopifyPrivacyRequest.updateMany({
      where: { shopDomain, clientId: null }, data: { clientId }
    });
    return count;
  }

  // ── What the merchant sees ────────────────────────────────────────────────────────────────

  /** The requests for this workspace. Identifiers and counts only. */
  async list(clientId: string) {
    const rows = await prisma.shopifyPrivacyRequest.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    return rows.map(r => ({
      id: r.id,
      topic: r.topic,
      shopDomain: r.shopDomain,
      status: r.status,
      shopifyCustomerId: r.shopifyCustomerId,
      shopifyRequestId: r.shopifyRequestId,
      orderCount: r.shopifyOrderIds.length,
      summary: r.summary,
      detail: r.detail,
      receivedAt: r.createdAt,
      completedAt: r.completedAt,
      exportedAt: r.exportedAt,
      canExport: r.topic === 'customers/data_request'
    }));
  }

  /**
   * Everything held about the customer in a data request, read now.
   *
   * Read at export rather than copied at arrival, so the privacy table never becomes a second
   * place anyone's address lives. The first export marks the request done: from then on it is the
   * merchant's to send.
   */
  async export(clientId: string, requestId: string, userId?: string) {
    const request = await prisma.shopifyPrivacyRequest.findFirst({ where: { id: requestId, clientId } });
    if (!request) throw Object.assign(new Error('That privacy request was not found.'), { statusCode: 404 });
    if (request.topic !== 'customers/data_request') {
      throw Object.assign(new Error('Only a data request has anything to export.'), { statusCode: 400 });
    }

    const found = await this.gather({
      clientId, shopDomain: request.shopDomain,
      shopifyCustomerId: request.shopifyCustomerId, shopifyOrderIds: request.shopifyOrderIds
    });
    const { businessName } = await getShopSettings(clientId);

    await prisma.shopifyPrivacyRequest.update({
      where: { id: request.id },
      data: {
        exportedAt: new Date(), exportedBy: userId ?? null,
        ...(request.status === 'WAITING_FOR_MERCHANT'
          ? { status: 'COMPLETED', completedAt: new Date(), detail: 'Exported. Send it to the customer.' }
          : {})
      }
    });

    const money = (v: unknown) => Number(v);
    return {
      about: {
        heldBy: businessName ?? clientId,
        store: request.shopDomain,
        shopifyCustomerId: request.shopifyCustomerId,
        shopifyDataRequestId: request.shopifyRequestId,
        ordersRequested: request.shopifyOrderIds,
        requestReceivedAt: request.createdAt,
        generatedAt: new Date()
      },
      customers: found.customers.map(c => ({
        customerNumber: c.customerCode,
        name: c.name,
        companyName: c.companyName,
        email: c.email,
        phone: c.phone,
        gstNumber: c.gstNumber,
        billingAddress: c.billingAddress,
        shippingAddress: c.shippingAddress,
        notes: c.notes,
        groups: c.tags,
        firstSeen: c.createdAt
      })),
      orders: found.orders.map(o => ({
        orderNumber: o.orderNumber,
        shopifyOrderId: o.externalOrderId,
        placedAt: o.createdAt,
        status: o.status,
        nameOnOrder: o.customerName,
        phoneOnOrder: o.customerPhone,
        billingAddress: o.billingAddress,
        shippingAddress: o.shippingAddress,
        items: o.items.map(i => ({
          sku: i.variant.sku,
          quantity: i.quantity,
          listUnitPrice: money(i.listUnitPrice),
          unitPrice: money(i.unitPrice),
          total: money(i.totalPrice)
        })),
        discounts: o.discounts.map(d => ({ title: d.title, amount: money(d.amount) })),
        subtotal: money(o.subtotal),
        discount: money(o.discountAmount),
        tax: money(o.taxAmount),
        shipping: money(o.shippingAmount),
        total: money(o.total),
        returns: o.returns.map(r => ({
          returnNumber: r.returnNumber, status: r.status, refund: money(r.refundTotal), createdAt: r.createdAt
        }))
      })),
      shopifyMessagesHeld: found.inbox.map(row => ({
        topic: row.topic,
        shopifyOrderId: row.shopifyOrderId,
        receivedAt: row.createdAt,
        personalDetails: personalPartsOf(row.payload)
      }))
    };
  }

  // ── The work ──────────────────────────────────────────────────────────────────────────────

  private async scopeOf(request: {
    shopDomain: string; clientId: string | null; shopifyCustomerId: string | null; shopifyOrderIds: string[];
  }): Promise<Scope> {
    // The installation's owner now, not at arrival: a store claimed in between has one.
    const installation = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain: request.shopDomain }, select: { clientId: true }
    });
    return {
      clientId: installation?.clientId ?? request.clientId,
      shopDomain: request.shopDomain,
      shopifyCustomerId: request.shopifyCustomerId,
      shopifyOrderIds: request.shopifyOrderIds
    };
  }

  /**
   * Who and what a request is about.
   *
   *   customers  the Shopify customer's own record, plus any record this store created for them by
   *              email alone (an order with an email and no Shopify customer id).
   *   orders     Shopify orders from this workspace named in the request, or placed by those records.
   *   inbox      webhook bodies from this store for those orders, or naming this customer.
   *
   * A customer the shop knew BEFORE Shopify -- matched to an order by email -- is not in
   * `customers`: that record is the shop's own, not something Shopify gave us. Their Shopify orders
   * are still in `orders`.
   */
  private async gather(scope: Scope) {
    const { clientId, shopDomain, shopifyCustomerId, shopifyOrderIds } = scope;

    const inboxIds = await this.inboxIdsFor(shopDomain, shopifyCustomerId, shopifyOrderIds);
    const inbox = inboxIds.length
      ? await prisma.shopifyOrderInbox.findMany({ where: { id: { in: inboxIds } }, orderBy: { createdAt: 'asc' } })
      : [];

    if (!clientId) return { customers: [], orders: [], inbox, keptCustomerIds: [] as string[] };

    const own = shopifyCustomerId && shopifyCustomerId !== 'guest'
      ? await prisma.customer.findMany({ where: { clientId, externalCustomerId: `shopify:${shopifyCustomerId}` } })
      : [];
    const ownIds = own.map(c => c.id);

    const or: any[] = [];
    if (shopifyOrderIds.length) or.push({ externalOrderId: { in: shopifyOrderIds } });
    if (ownIds.length) or.push({ customerId: { in: ownIds } });

    const orders = or.length
      ? await prisma.salesOrder.findMany({
          where: { clientId, sourceSystem: 'SHOPIFY', OR: or },
          include: {
            items: { include: { variant: { select: { sku: true } } }, orderBy: { createdAt: 'asc' } },
            discounts: { orderBy: { createdAt: 'asc' } },
            returns: { orderBy: { createdAt: 'asc' } }
          },
          orderBy: { createdAt: 'asc' }
        })
      : [];

    // Records this store made by email for the same orders -- theirs only if every order on the
    // record is one of these. One other order (a sale at the till, another customer's checkout
    // using a shared email) and the record is the shop's, not this request's.
    const orderIds = orders.map(o => o.id);
    const otherIds = [...new Set(orders.map(o => o.customerId))].filter(id => !ownIds.includes(id));
    const candidates = otherIds.length
      ? await prisma.customer.findMany({
          where: { id: { in: otherIds }, clientId, sourceStore: shopDomain, externalCustomerId: null }
        })
      : [];

    const byEmail: typeof candidates = [];
    const keptCustomerIds: string[] = [];
    for (const c of candidates) {
      const elsewhere = await prisma.salesOrder.count({ where: { customerId: c.id, id: { notIn: orderIds } } });
      if (elsewhere === 0) byEmail.push(c);
      else keptCustomerIds.push(c.id);
    }
    // Records not made by this store at all are the shop's own; counted as kept, never touched.
    for (const id of otherIds) {
      if (!candidates.some(c => c.id === id)) keptCustomerIds.push(id);
    }

    return { customers: [...own, ...byEmail], orders, inbox, keptCustomerIds: [...new Set(keptCustomerIds)] };
  }

  private async inboxIdsFor(shopDomain: string, shopifyCustomerId: string | null, shopifyOrderIds: string[]) {
    if (!shopifyCustomerId && shopifyOrderIds.length === 0) return [];
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM shopify_order_inbox
       WHERE shop_domain = ${shopDomain}
         AND (shopify_order_id = ANY(${shopifyOrderIds}::text[])
              OR (${shopifyCustomerId}::text IS NOT NULL AND payload->'customer'->>'id' = ${shopifyCustomerId}::text))`;
    return rows.map(r => r.id);
  }

  private async eraseCustomer(scope: Scope) {
    const found = await this.gather(scope);
    const customerIds = found.customers.map(c => c.id);
    const orderIds = found.orders.map(o => o.id);

    await prisma.$transaction(async tx => {
      if (customerIds.length) {
        await tx.customer.updateMany({ where: { id: { in: customerIds } }, data: ERASED_CUSTOMER });
      }
      if (orderIds.length) {
        await tx.salesOrder.updateMany({ where: { id: { in: orderIds } }, data: ERASED_ORDER_COPY });
      }
      for (const row of found.inbox) {
        await tx.shopifyOrderInbox.update({
          where: { id: row.id }, data: { payload: scrubShopifyPayload(row.payload) as any }
        });
      }
    }, { timeout: 30000 });

    return {
      customersErased: customerIds.length,
      customersKept: found.keptCustomerIds.length,
      ordersCleared: orderIds.length,
      shopifyMessagesCleared: found.inbox.length
    };
  }

  /**
   * A store's data, 48 hours after it uninstalled.
   *
   * Skipped -- loudly -- if the store has the app again: an erase of a live store's customers is the
   * one outcome here with no way back, and Shopify should not send this for a reinstalled store.
   */
  private async eraseShop(shopDomain: string): Promise<{
    skipped: boolean; clientId: string | null; detail: string; summary?: Record<string, number>;
  }> {
    const installation = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain }, select: { id: true, clientId: true, uninstalledAt: true }
    });

    if (installation && !installation.uninstalledAt) {
      return {
        skipped: true, clientId: installation.clientId,
        detail: 'The app is installed on this store again, so nothing was erased.'
      };
    }

    const clientId = installation?.clientId ?? null;

    const summary = await prisma.$transaction(async tx => {
      const customers = clientId
        ? await tx.customer.updateMany({ where: { clientId, sourceStore: shopDomain }, data: ERASED_CUSTOMER })
        : { count: 0 };
      const orders = clientId
        ? await tx.salesOrder.updateMany({ where: { clientId, sourceStore: shopDomain }, data: ERASED_ORDER_COPY })
        : { count: 0 };
      // Nothing parked can ever be placed now, and every body names a customer.
      const inbox = await tx.shopifyOrderInbox.deleteMany({ where: { shopDomain } });
      await tx.shopifyOAuthState.deleteMany({ where: { shopDomain } });
      // The installation cascades its product and location pairings, discount copies and echoes.
      const installs = await tx.shopifyInstallation.deleteMany({ where: { shopDomain } });
      return {
        customersErased: customers.count,
        ordersCleared: orders.count,
        shopifyMessagesDeleted: inbox.count,
        installationsRemoved: installs.count
      };
    }, { timeout: 30000 });

    return { skipped: false, clientId, detail: 'Erased.', summary };
  }
}

/** A customer record with nobody left in it. The number, the Shopify id and the store stay. */
const ERASED_CUSTOMER = {
  name: ERASED_NAME,
  companyName: null,
  email: null,
  phone: null,
  gstNumber: null,
  billingAddress: null,
  shippingAddress: null,
  notes: null,
  tags: [] as string[]
};

/** The copy of the customer an order keeps. The order itself -- lines, money, stock -- is untouched. */
const ERASED_ORDER_COPY = {
  customerName: null,
  customerPhone: null,
  billingAddress: null,
  shippingAddress: null
};

export const shopifyPrivacyService = new ShopifyPrivacyService();
