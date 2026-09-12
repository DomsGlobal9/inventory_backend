/**
 * The Shopify orders we could not place, and getting them placed.
 *
 * Parking was built in Phase 1 and was exactly right -- never guess, never drop. What was missing
 * was the other half: nobody could SEE a parked order, and nothing ever tried it again. A shop
 * whose first Shopify sale arrived before its location was paired would have had that sale sit
 * in a table for ever, and the merchant would only have found out by noticing their Shopify
 * total and their ScaleEzy total disagreed.
 *
 * So this service does four things:
 *
 *   list / summary   what is waiting, one entry per ORDER, with a reason a shop owner can act on
 *   replay           try an order again -- the newest payload, then whatever happened to it
 *                    while it waited (shipped, refunded), in the order it happened
 *   dismiss          settle one that should never be placed, with a reason
 *   housekeeping     attach a store's parked orders when it is claimed, close them when the
 *                    app is uninstalled
 *
 * Replay goes through the SAME ingest, fulfilment and refund services the webhooks use. A replay
 * path that re-implemented any of it would be a second way of placing a Shopify order, and the
 * two would drift.
 */

import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../utils/httpError';
import { shopifyOrderIngestService } from './ingest.service';
import { shopifyFulfilmentService } from './fulfilment.service';
import { shopifyRefundService } from './refund.service';
import { ORDER_TOPICS, FULFILMENT_TOPIC, isRefundTopic } from './parking';

/** What a merchant is told each reason means, and what to do about it. */
export const REASON_GUIDANCE: Record<string, { label: string; action: string }> = {
  UNMAPPED_LOCATION: {
    label: 'Location not paired',
    action: 'Pair your Shopify locations with your locations here, then retry.'
  },
  UNMAPPED_VARIANT: {
    label: 'Product not recognised',
    action: 'Match your Shopify products by SKU, then retry. A SKU that exists only in Shopify needs adding here first.'
  },
  CURRENCY_MISMATCH: {
    label: 'Different currency',
    action: 'This order is in a different currency from your shop. It is never converted; dismiss it if it should not be here.'
  },
  NOT_SYNCED: {
    label: 'Store still syncing',
    action: 'Retry once the first catalogue sync has finished.'
  },
  UNCLAIMED_INSTALL: {
    label: 'Store not claimed',
    action: 'Claim this Shopify store in Settings, then retry.'
  },
  RECONCILE_MISMATCH: {
    label: 'Totals do not agree',
    action: 'Shopify\'s totals for this order do not add up. Check it in Shopify, then retry or dismiss.'
  },
  AWAITING_ORDER: {
    label: 'Waiting for its order',
    action: 'Applied automatically once the order itself is placed.'
  },
  FAILED: {
    label: 'Could not be placed',
    action: 'Retry. If it keeps failing, contact support with the order number.'
  }
};

const isOrderTopic = (topic: string) => ORDER_TOPICS.includes(topic);

/** Shopify's `updated_at`, for picking the newest of several payloads for one order. */
const updatedAtOf = (row: { payload: any; updatedAt: Date }) => {
  const stamp = Date.parse(row.payload?.updated_at ?? '');
  return Number.isNaN(stamp) ? row.updatedAt.getTime() : stamp;
};

export type ReplayResult =
  | { status: 'PLACED'; orderNumber: string; salesOrderId: string; followUps: number }
  | { status: 'ALREADY_PLACED'; orderNumber: string; salesOrderId: string; followUps: number }
  | { status: 'WAITING'; reason: string; detail: string };

export class ShopifyInboxService {
  /**
   * What is waiting, as one entry per order.
   *
   * The table holds a row per EVENT -- an `orders/create`, the `orders/updated` that followed it,
   * a fulfilment, two refunds. A merchant does not think in events: they think "order #1042 is
   * stuck". Five rows for one order would read as five problems and bury the other orders.
   *
   * The payload is read for display only: the order's name as the customer saw it (#1042), what
   * it came to, and when. Nothing else leaves this function -- a Shopify payload carries the
   * customer's address and phone, which the panel has no use for.
   */
  async list(clientId: string, state: 'open' | 'resolved' = 'open', limit = 100) {
    const rows = await prisma.shopifyOrderInbox.findMany({
      where: { clientId, resolvedAt: state === 'open' ? null : { not: null } },
      orderBy: { createdAt: 'asc' },
      take: 2000
    });

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.shopDomain}|${row.shopifyOrderId}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    const orderIds = [...new Set(rows.map(r => r.salesOrderId).filter(Boolean))] as string[];
    const placed = orderIds.length
      ? await prisma.salesOrder.findMany({
          where: { id: { in: orderIds }, clientId },
          select: { id: true, orderNumber: true }
        })
      : [];
    const numberOf = new Map(placed.map(o => [o.id, o.orderNumber]));

    const entries = [...groups.values()].map(group => {
      const orderRows = group.filter(r => isOrderTopic(r.topic));
      // The ORDER's own row explains why it is stuck. A follow-up's "waiting for its order" is
      // true but not the thing to fix.
      const lead = [...(orderRows.length ? orderRows : group)]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      const newest = [...(orderRows.length ? orderRows : group)].sort((a, b) => updatedAtOf(b) - updatedAtOf(a))[0];
      const payload: any = newest.payload ?? {};
      const guidance = REASON_GUIDANCE[lead.reason] ?? REASON_GUIDANCE.FAILED;

      return {
        id: lead.id,
        shopDomain: lead.shopDomain,
        shopifyOrderId: lead.shopifyOrderId,
        orderName: typeof payload.name === 'string' ? payload.name : `#${lead.shopifyOrderId}`,
        total: payload.total_price != null ? Number(payload.total_price) : null,
        currency: typeof payload.currency === 'string' ? payload.currency : null,
        placedInShopifyAt: payload.created_at ?? null,
        reason: lead.reason,
        reasonLabel: guidance.label,
        action: guidance.action,
        detail: lead.detail,
        attempts: Math.max(...group.map(r => r.attempts)),
        // What else is waiting behind the order, said in words rather than topic names.
        alsoWaiting: {
          shipment: group.some(r => r.topic === FULFILMENT_TOPIC && (state === 'resolved' || !r.resolvedAt)),
          refunds: group.filter(r => isRefundTopic(r.topic)).length
        },
        firstParkedAt: group[0].createdAt,
        lastTriedAt: lead.updatedAt,
        resolvedAt: lead.resolvedAt,
        resolvedBy: lead.resolvedBy,
        salesOrderId: group.find(r => r.salesOrderId)?.salesOrderId ?? null,
        orderNumber: numberOf.get(group.find(r => r.salesOrderId)?.salesOrderId ?? '') ?? null
      };
    });

    // Open: oldest first, because the oldest is the one a customer has waited longest for.
    // Resolved: newest first, because the question is "what just happened".
    entries.sort((a, b) => state === 'open'
      ? a.firstParkedAt.getTime() - b.firstParkedAt.getTime()
      : (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0));

    return { total: entries.length, entries: entries.slice(0, limit) };
  }

  /** "3 orders are waiting -- 2 need a location paired", for a banner. */
  async summary(clientId: string) {
    const { entries } = await this.list(clientId, 'open', 100000);
    const byReason: Record<string, number> = {};
    for (const e of entries) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
    return {
      waiting: entries.length,
      byReason: Object.entries(byReason).map(([reason, count]) => ({
        reason, count, label: (REASON_GUIDANCE[reason] ?? REASON_GUIDANCE.FAILED).label
      }))
    };
  }

  /** Try one parked order again, by the id of any of its rows. */
  async replay(clientId: string, inboxId: string, userId?: string): Promise<ReplayResult> {
    const row = await prisma.shopifyOrderInbox.findFirst({
      where: { id: inboxId, clientId },
      select: { shopDomain: true, shopifyOrderId: true, resolvedAt: true }
    });
    if (!row) throw notFound('That waiting order is no longer here.');
    if (row.resolvedAt) throw badRequest('That order has already been settled. Refresh to see where it went.');

    return this.replayOrder(clientId, row.shopDomain, row.shopifyOrderId, userId);
  }

  /**
   * Try every waiting order again.
   *
   * Run after anything that could unblock them: a location paired, products matched, a store
   * claimed. One at a time, deliberately -- each placement reserves stock, and two placements of
   * different orders racing for the last units of a saree is a real contention the reservation
   * service resolves correctly only if it is not being hammered in parallel for no benefit.
   *
   * Bounded, so a store with thousands of parked orders cannot hold one request open for
   * minutes. What is left over is reported, and the next retry carries on.
   */
  async replayAll(clientId: string, userId?: string, max = 200) {
    const open = await prisma.shopifyOrderInbox.findMany({
      where: { clientId, resolvedAt: null },
      select: { shopDomain: true, shopifyOrderId: true, createdAt: true },
      orderBy: { createdAt: 'asc' }
    });

    const seen = new Set<string>();
    const orders: { shopDomain: string; shopifyOrderId: string }[] = [];
    for (const r of open) {
      const key = `${r.shopDomain}|${r.shopifyOrderId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      orders.push({ shopDomain: r.shopDomain, shopifyOrderId: r.shopifyOrderId });
    }

    let placed = 0;
    let stillWaiting = 0;
    for (const o of orders.slice(0, max)) {
      try {
        const result = await this.replayOrder(clientId, o.shopDomain, o.shopifyOrderId, userId);
        if (result.status === 'WAITING') stillWaiting++;
        else placed++;
      } catch (error) {
        // One bad order must not stop the other forty from being placed.
        console.error(`[Shopify] replay of ${o.shopifyOrderId} failed`, error);
        stillWaiting++;
      }
    }

    return { tried: Math.min(orders.length, max), placed, stillWaiting, notTriedYet: Math.max(0, orders.length - max) };
  }

  /**
   * The actual replay, for one Shopify order.
   *
   * 1. The ORDER, from its newest payload. `orders/create` and `orders/updated` may both be
   *    parked; replaying the older one first and then letting it settle both rows would lose the
   *    update. The newest payload IS the order as it stands.
   * 2. Then what happened to it while it waited -- the shipment, then each refund, in the order
   *    they arrived. Shipped before refunded, because a refund of goods that never left is a
   *    different movement from a return.
   */
  async replayOrder(clientId: string, shopDomain: string, shopifyOrderId: string, userId?: string): Promise<ReplayResult> {
    const rows = await prisma.shopifyOrderInbox.findMany({
      where: { clientId, shopDomain, shopifyOrderId, resolvedAt: null },
      orderBy: { createdAt: 'asc' }
    });

    const orderRows = rows.filter(r => isOrderTopic(r.topic));

    if (orderRows.length > 0) {
      const newest = [...orderRows].sort((a, b) => updatedAtOf(b) - updatedAtOf(a))[0];
      const outcome = await shopifyOrderIngestService.ingest(shopDomain, newest.payload, newest.topic);

      if (outcome.status === 'PARKED') {
        return { status: 'WAITING', reason: outcome.reason, detail: outcome.detail };
      }

      // STALE means the order is already here and newer than this payload -- a webhook got
      // through after the order was parked. Either way the order rows are done.
      //
      // Not filtered on `resolvedAt: null`: ingest has already closed these rows as 'system' the
      // moment the order was placed, and that filter made every retry a person pressed read as
      // if nobody had. These are the rows that were open when this replay began, so stamping
      // who did it is exactly right.
      await prisma.shopifyOrderInbox.updateMany({
        where: { id: { in: orderRows.map(r => r.id) } },
        data: {
          resolvedAt: new Date(),
          resolvedBy: userId ?? 'system',
          ...(outcome.status === 'APPLIED' ? { salesOrderId: outcome.salesOrderId } : {})
        }
      });
    }

    const order = await prisma.salesOrder.findFirst({
      where: { clientId, externalOrderId: shopifyOrderId, sourceSystem: 'SHOPIFY', deletedAt: null },
      select: { id: true, orderNumber: true }
    });

    if (!order) {
      // Only follow-ups were open, and their order is not here. Nothing to apply them to.
      const lead = rows[rows.length - 1];
      return {
        status: 'WAITING',
        reason: lead?.reason ?? 'AWAITING_ORDER',
        detail: lead?.detail ?? 'Its order has not been placed yet.'
      };
    }

    const followUps = await this.applyFollowUps(clientId, shopDomain, shopifyOrderId, order.id, userId);

    return {
      status: orderRows.length > 0 ? 'PLACED' : 'ALREADY_PLACED',
      orderNumber: order.orderNumber,
      salesOrderId: order.id,
      followUps
    };
  }

  /**
   * The shipment and refunds that arrived while an order waited.
   *
   * Public because the webhook route calls it too: an order can be placed by a fresh
   * `orders/updated` from Shopify, not only by somebody pressing Retry, and its waiting shipment
   * must not depend on which of those happened.
   */
  async applyFollowUps(clientId: string, shopDomain: string, shopifyOrderId: string, salesOrderId: string, userId?: string) {
    const rows = await prisma.shopifyOrderInbox.findMany({
      where: { clientId, shopDomain, shopifyOrderId, resolvedAt: null, NOT: { topic: { in: ORDER_TOPICS } } },
      orderBy: { createdAt: 'asc' }
    });

    const ordered = [
      ...rows.filter(r => r.topic === FULFILMENT_TOPIC),
      ...rows.filter(r => isRefundTopic(r.topic))
    ];

    let applied = 0;
    for (const row of ordered) {
      const outcome = row.topic === FULFILMENT_TOPIC
        ? await shopifyFulfilmentService.apply(shopDomain, row.payload)
        : await shopifyRefundService.apply(shopDomain, row.payload);

      // PARKED again would mean the order vanished between the lookup and now; leave it open.
      if (outcome === 'PARKED') continue;

      await prisma.shopifyOrderInbox.update({
        where: { id: row.id },
        data: { resolvedAt: new Date(), resolvedBy: userId ?? 'system', salesOrderId }
      });
      applied++;
    }
    return applied;
  }

  /**
   * Settle an order that should never be placed.
   *
   * A test order from before the shop went live, an order in the wrong currency, a duplicate
   * the merchant already entered by hand. The reason is required for the same reason a manual
   * discount needs one: "dismissed" with nothing beside it, six months later, is
   * indistinguishable from a sale somebody made disappear.
   *
   * The whole order goes, including anything waiting behind it -- a shipment for an order that
   * will never exist here has nothing to be applied to.
   */
  async dismiss(clientId: string, inboxId: string, userId: string | undefined, reason: string) {
    const why = String(reason ?? '').trim();
    if (why.length < 4) {
      throw badRequest('Say why this order should not be placed. It is kept, and it is the only record of the decision.');
    }
    if (why.length > 300) throw badRequest('Keep the reason under 300 characters.');

    const row = await prisma.shopifyOrderInbox.findFirst({
      where: { id: inboxId, clientId },
      select: { shopDomain: true, shopifyOrderId: true, resolvedAt: true }
    });
    if (!row) throw notFound('That waiting order is no longer here.');
    if (row.resolvedAt) throw badRequest('That order has already been settled. Refresh to see where it went.');

    const { count } = await prisma.shopifyOrderInbox.updateMany({
      where: { clientId, shopDomain: row.shopDomain, shopifyOrderId: row.shopifyOrderId, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedBy: userId ?? 'unknown', detail: `Dismissed: ${why}` }
    });
    return { dismissed: count };
  }

  /**
   * A store has just been claimed: its parked orders now have an owner.
   *
   * Parked while unclaimed, they carry no clientId -- nobody knew whose they were, so no
   * tenant's panel could show them. Claiming answers the question.
   */
  async attachClaimed(shopDomain: string, clientId: string) {
    const { count } = await prisma.shopifyOrderInbox.updateMany({
      where: { shopDomain, clientId: null, resolvedAt: null },
      data: { clientId }
    });
    return count;
  }

  /**
   * The app was removed from the store. Nothing parked can ever be placed now.
   *
   * Closed rather than deleted, so a merchant who reinstalls can still see what was waiting when
   * they left -- and closed rather than left open, so a panel does not show forty orders with a
   * Retry button that can never work.
   */
  async closeForUninstall(shopDomain: string) {
    const { count } = await prisma.shopifyOrderInbox.updateMany({
      where: { shopDomain, resolvedAt: null },
      data: {
        resolvedAt: new Date(),
        resolvedBy: 'system',
        detail: 'The app was uninstalled from this Shopify store before this order could be placed.'
      }
    });
    return count;
  }
}

export const shopifyInboxService = new ShopifyInboxService();
