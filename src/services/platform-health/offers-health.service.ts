/**
 * Offers and Shopify, across every shop, for the people who look after the platform.
 *
 * The console could say which shop is running out of stock and which one had errors, and nothing
 * at all about the money a shop takes off or the copies it keeps on Shopify. The questions the
 * support team is actually asked -- "my discount stopped working on Shopify", "an order never
 * arrived", "the VIP offer does nothing" -- had no screen, and the only way to answer them was to
 * sign in as the shop and look.
 *
 * One row per shop, worst first. Everything is a grouped query, so the page costs the same few
 * queries whether there are ten shops or a thousand: the Clients page learned that the hard way
 * (see listClients in platform-admin.service.ts), when it asked per shop and fell over at sixteen.
 *
 * Read only. Nothing here changes a shop.
 */
import { prisma } from '../../lib/prisma';
import { RBAC_DATA } from '../rbac-seed.service';

const DAY = 86_400_000;

export interface OffersHealthRow {
  clientId: string;
  offers: { running: number; scheduled: number; waiting: number; total: number; outOfCodes: number };
  last30Days: { uses: number; discountGiven: number; ordersWithOffers: number };
  quotesLast7Days: { priced: number; ordered: number };
  tillLimitPercent: number | null;
  shopify: {
    copies: Record<string, number>;
    ordersWaiting: number;
    ordersWaitingByReason: Record<string, number>;
  };
  rolesMissingOfferPermissions: string[];
  /** Plain sentences, worst first. Empty means nothing needs anybody. */
  attention: string[];
}

export class OffersHealthService {
  async overview(now: Date = new Date()): Promise<{ clients: OffersHealthRow[]; platform: Record<string, number> }> {
    const since30 = new Date(now.getTime() - 30 * DAY);
    const since7 = new Date(now.getTime() - 7 * DAY);

    const builtIn = Object.entries(RBAC_DATA.roles)
      .filter(([, r]) => !(r.permissions as readonly string[]).includes('*'))
      .map(([name, r]) => ({ name, offer: (r.permissions as readonly string[]).filter(p => p.startsWith('offer:')) }));

    const [tenants, offerRows, useRows, quoteRows, settings, mirrorRows, inboxRows, unclaimed, roles] = await Promise.all([
      prisma.user.findMany({ distinct: ['clientId'], select: { clientId: true } }),
      prisma.$queryRaw<{ client_id: string; running: bigint; scheduled: bigint; waiting: bigint; total: bigint; out_of_codes: bigint }[]>`
        SELECT o.client_id,
               COUNT(*) FILTER (WHERE o.status = 'ACTIVE' AND o.starts_at <= ${now} AND (o.ends_at IS NULL OR o.ends_at > ${now})) AS running,
               COUNT(*) FILTER (WHERE o.status = 'ACTIVE' AND o.starts_at > ${now})                                               AS scheduled,
               COUNT(*) FILTER (WHERE o.status IN ('DRAFT', 'PAUSED'))                                                            AS waiting,
               COUNT(*) FILTER (WHERE o.status <> 'ARCHIVED')                                                                     AS total,
               -- Running on single-use codes, with none left to hand out: every customer holding a
               -- card has used it, and anybody new is told the code is not valid.
               COUNT(*) FILTER (WHERE o.status = 'ACTIVE' AND o.unique_codes AND (o.ends_at IS NULL OR o.ends_at > ${now})
                                  AND NOT EXISTS (SELECT 1 FROM offer_codes c WHERE c.offer_id = o.id AND c.used_at IS NULL)) AS out_of_codes
          FROM offers o
         GROUP BY o.client_id
      `,
      prisma.$queryRaw<{ client_id: string; uses: bigint; given: any; orders: bigint }[]>`
        SELECT client_id, COUNT(*) AS uses, COALESCE(SUM(amount), 0) AS given, COUNT(DISTINCT sales_order_id) AS orders
          FROM offer_redemptions
         WHERE status = 'COUNTED' AND created_at >= ${since30}
         GROUP BY client_id
      `,
      prisma.$queryRaw<{ client_id: string; priced: bigint; ordered: bigint }[]>`
        SELECT client_id, COUNT(*) AS priced, COUNT(*) FILTER (WHERE consumed_at IS NOT NULL) AS ordered
          FROM pricing_quotes
         WHERE created_at >= ${since7}
         GROUP BY client_id
      `,
      prisma.clientSettings.findMany({ where: { manualDiscountMaxPercent: { not: null } }, select: { clientId: true, manualDiscountMaxPercent: true } }),
      prisma.offerExternalMirror.groupBy({ by: ['clientId', 'status'], _count: { _all: true } }),
      prisma.shopifyOrderInbox.groupBy({ by: ['clientId', 'reason'], where: { resolvedAt: null, clientId: { not: null } }, _count: { _all: true } }),
      // Orders from a Shopify store nobody has claimed yet belong to no shop, so they appear once,
      // for the whole platform, rather than under a row.
      prisma.shopifyOrderInbox.count({ where: { resolvedAt: null, clientId: null } }),
      prisma.role.findMany({
        where: { name: { in: builtIn.map(r => r.name) } },
        select: { clientId: true, name: true, permissions: { select: { permission: { select: { key: true } } } } }
      })
    ]);

    const offersBy = new Map(offerRows.map(r => [r.client_id, r]));
    const usesBy = new Map(useRows.map(r => [r.client_id, r]));
    const quotesBy = new Map(quoteRows.map(r => [r.client_id, r]));
    const limitBy = new Map(settings.map(s => [s.clientId, Number(s.manualDiscountMaxPercent)]));

    const copiesBy = new Map<string, Record<string, number>>();
    for (const m of mirrorRows) {
      const at = copiesBy.get(m.clientId) ?? {};
      at[m.status] = m._count._all;
      copiesBy.set(m.clientId, at);
    }
    const inboxBy = new Map<string, Record<string, number>>();
    for (const i of inboxRows) {
      const at = inboxBy.get(i.clientId!) ?? {};
      at[i.reason] = i._count._all;
      inboxBy.set(i.clientId!, at);
    }
    const missingBy = new Map<string, string[]>();
    for (const role of roles) {
      const expected = builtIn.find(b => b.name === role.name)!.offer;
      const held = new Set(role.permissions.map(p => p.permission.key));
      const lacking = expected.filter(k => !held.has(k));
      if (lacking.length) missingBy.set(role.clientId, [...(missingBy.get(role.clientId) ?? []), `${role.name}: ${lacking.join(', ')}`]);
    }

    const n = (v: bigint | number | undefined | null) => Number(v ?? 0);
    const clients = tenants.map(({ clientId }): OffersHealthRow => {
      const o = offersBy.get(clientId);
      const u = usesBy.get(clientId);
      const q = quotesBy.get(clientId);
      const copies = copiesBy.get(clientId) ?? {};
      const byReason = inboxBy.get(clientId) ?? {};
      const waiting = Object.values(byReason).reduce((s, c) => s + c, 0);
      const missing = missingBy.get(clientId) ?? [];
      const row: OffersHealthRow = {
        clientId,
        offers: { running: n(o?.running), scheduled: n(o?.scheduled), waiting: n(o?.waiting), total: n(o?.total), outOfCodes: n(o?.out_of_codes) },
        last30Days: { uses: n(u?.uses), discountGiven: Number(u?.given ?? 0), ordersWithOffers: n(u?.orders) },
        quotesLast7Days: { priced: n(q?.priced), ordered: n(q?.ordered) },
        tillLimitPercent: limitBy.get(clientId) ?? null,
        shopify: { copies, ordersWaiting: waiting, ordersWaitingByReason: byReason },
        rolesMissingOfferPermissions: missing,
        attention: []
      };
      const say = (count: number, one: string, many: string) => { if (count > 0) row.attention.push(count === 1 ? one : many.replace('#', String(count))); };
      say(copies.FAILED ?? 0, 'An offer could not be copied to Shopify', '# offers could not be copied to Shopify');
      say(waiting, 'A Shopify order is waiting to be let in', '# Shopify orders are waiting to be let in');
      say(copies.DRIFTED ?? 0, 'An offer was changed inside Shopify', '# offers were changed inside Shopify');
      say(row.offers.outOfCodes, 'A running offer has no single-use codes left', '# running offers have no single-use codes left');
      if (missing.length) row.attention.push(`Built-in roles are missing offer permissions (${missing.length})`);
      return row;
    });

    // Worst first: what needs somebody, then the busiest.
    clients.sort((a, b) => b.attention.length - a.attention.length
      || (b.shopify.ordersWaiting + (b.shopify.copies.FAILED ?? 0)) - (a.shopify.ordersWaiting + (a.shopify.copies.FAILED ?? 0))
      || b.last30Days.uses - a.last30Days.uses
      || a.clientId.localeCompare(b.clientId));

    const platform = {
      shops: clients.length,
      shopsNeedingAttention: clients.filter(c => c.attention.length > 0).length,
      offersRunning: clients.reduce((s, c) => s + c.offers.running, 0),
      usesLast30Days: clients.reduce((s, c) => s + c.last30Days.uses, 0),
      discountGivenLast30Days: Math.round(clients.reduce((s, c) => s + c.last30Days.discountGiven, 0) * 100) / 100,
      shopifyCopiesFailing: clients.reduce((s, c) => s + (c.shopify.copies.FAILED ?? 0), 0),
      shopifyOrdersWaiting: clients.reduce((s, c) => s + c.shopify.ordersWaiting, 0),
      shopifyOrdersUnclaimed: unclaimed
    };

    return { clients, platform };
  }
}

export const offersHealthService = new OffersHealthService();
