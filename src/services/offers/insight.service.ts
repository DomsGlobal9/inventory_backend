/**
 * Everything the offer screens need to READ that is not the offer itself.
 *
 *   options      what an offer can be pointed at in this shop: departments, garment types,
 *                locations -- each with how much of the catalogue it covers, so "Sarees (42)"
 *                tells the merchant what they are about to discount.
 *   search       products or items by name, code or SKU, for the picker.
 *   detail       one offer with its targets named, its results, the orders that used it, and a
 *                history that says what changed rather than dumping two JSON blobs.
 *
 * Kept out of offer.service, which writes, so the rules about keeping history are not buried under
 * reporting queries.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest } from '../../utils/httpError';
import { offerService } from './offer.service';
import { describeChanges, Labels } from './describe';
import { normaliseType } from '../pricing/engine';

const DEPARTMENTS = [
  { value: 'WOMEN', label: 'Women' },
  { value: 'MEN', label: 'Men' },
  { value: 'KIDS', label: 'Kids' },
  { value: 'UNISEX', label: 'Unisex' }
];

/** Products an offer could still sell. The bin is not the shop. */
const onSale: Prisma.ProductWhereInput = { trashedAt: null, status: { not: 'TRASHED' } };

const variantLabel = (v: { sku: string; size: string | null; colorName: string | null }) =>
  [v.sku, v.size, v.colorName].filter(Boolean).join(' · ');

export class OfferInsightService {
  async options(clientId: string) {
    const [byCategory, byType, catalogue, locations, tagRows] = await Promise.all([
      prisma.product.groupBy({ by: ['category'], where: { clientId, ...onSale }, _count: { _all: true } }),
      prisma.product.groupBy({ by: ['dressType'], where: { clientId, ...onSale, dressType: { not: null } }, _count: { _all: true } }),
      prisma.clientCatalogItem.findMany({
        where: { clientId, type: 'DRESS_TYPE', isActive: true },
        select: { label: true, value: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }]
      }),
      prisma.stockLocation.findMany({
        where: { clientId, active: true },
        select: { id: true, name: true, code: true, type: true },
        orderBy: [{ type: 'asc' }, { name: 'asc' }]
      }),
      // Every group a customer is in, with how many are in it, so "VIP (42)" says who gets it.
      prisma.$queryRaw<{ tag: string; count: bigint }[]>`
        SELECT t AS tag, COUNT(*) AS count
          FROM customers c, UNNEST(c.tags) AS t
         WHERE c.client_id = ${clientId} AND c.deleted_at IS NULL
         GROUP BY t ORDER BY COUNT(*) DESC, t ASC LIMIT 200`
    ]);

    const tagCounts = new Map<string, { value: string; count: number }>();
    for (const r of tagRows) {
      const key = r.tag.trim().toLowerCase();
      const at = tagCounts.get(key);
      if (at) at.count += Number(r.count);
      else tagCounts.set(key, { value: r.tag.trim(), count: Number(r.count) });
    }

    const categoryCount = new Map(byCategory.map(c => [c.category as string, c._count._all]));

    /*
     * Garment types come from two places and have to become one list.
     *
     * The catalogue says what a shop MEANT to call things; the products say what was actually
     * typed ("saree ", "Sarees"). Grouped case-blind and trimmed -- the same rule the engine
     * matches by -- so the count beside a type is exactly the number of products it will discount.
     * The catalogue's spelling wins where both exist, because it is the one somebody chose.
     */
    const types = new Map<string, { value: string; count: number; inCatalogue: boolean }>();
    for (const item of catalogue) {
      const key = normaliseType(item.label);
      if (key && !types.has(key)) types.set(key, { value: item.label.trim(), count: 0, inCatalogue: true });
    }
    for (const row of byType) {
      const key = normaliseType(row.dressType);
      if (!key) continue;
      const seen = types.get(key);
      if (seen) seen.count += row._count._all;
      else types.set(key, { value: String(row.dressType).trim(), count: row._count._all, inCatalogue: false });
    }

    return {
      departments: DEPARTMENTS.map(d => ({ ...d, count: categoryCount.get(d.value) ?? 0 })),
      dressTypes: [...types.values()]
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .map(t => ({ value: t.value, label: t.value, count: t.count })),
      locations: locations.map(l => ({ id: l.id, name: l.name, code: l.code, type: l.type })),
      channels: [
        { value: 'POS', label: 'Till' },
        { value: 'ONLINE', label: 'Online store' }
      ],
      customerTags: [...tagCounts.values()]
    };
  }

  /** Twenty at a time: a picker, not a catalogue browser. */
  async search(clientId: string, scope: string, q: string) {
    const term = q.trim().slice(0, 80);
    if (scope === 'PRODUCT') {
      const rows = await prisma.product.findMany({
        where: {
          clientId, ...onSale,
          ...(term ? { OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { productCode: { contains: term, mode: 'insensitive' } },
            { dressType: { contains: term, mode: 'insensitive' } },
            { variants: { some: { sku: { contains: term, mode: 'insensitive' } } } }
          ] } : {})
        },
        select: { id: true, title: true, productCode: true, dressType: true, _count: { select: { variants: true } } },
        orderBy: { title: 'asc' },
        take: 20
      });
      return rows.map(p => ({
        id: p.id,
        label: p.title,
        sub: [p.productCode, p.dressType, `${p._count.variants} ${p._count.variants === 1 ? 'item' : 'items'}`].filter(Boolean).join(' · ')
      }));
    }

    if (scope === 'VARIANT') {
      const rows = await prisma.productVariant.findMany({
        where: {
          clientId,
          product: onSale,
          ...(term ? { OR: [
            { sku: { contains: term, mode: 'insensitive' } },
            { variantCode: { contains: term, mode: 'insensitive' } },
            { product: { title: { contains: term, mode: 'insensitive' } } }
          ] } : {})
        },
        select: { id: true, sku: true, size: true, colorName: true, product: { select: { title: true } } },
        orderBy: [{ product: { title: 'asc' } }, { sku: 'asc' }],
        take: 20
      });
      return rows.map(v => ({ id: v.id, label: v.product.title, sub: variantLabel(v) }));
    }

    throw badRequest('Search products or items.');
  }

  /** What each id an offer holds is called -- including ones that have since gone. */
  async labels(clientId: string, refs: { scope: string; refId: string }[], locationIds: string[]): Promise<Labels> {
    const productIds = refs.filter(r => r.scope === 'PRODUCT').map(r => r.refId);
    const variantIds = refs.filter(r => r.scope === 'VARIANT').map(r => r.refId);

    const [products, variants, locations] = await Promise.all([
      productIds.length
        ? prisma.product.findMany({ where: { clientId, id: { in: productIds } }, select: { id: true, title: true, trashedAt: true } })
        : [],
      variantIds.length
        ? prisma.productVariant.findMany({
            where: { clientId, id: { in: variantIds } },
            select: { id: true, sku: true, size: true, colorName: true, product: { select: { title: true } } }
          })
        : [],
      locationIds.length
        ? prisma.stockLocation.findMany({ where: { clientId, id: { in: locationIds } }, select: { id: true, name: true } })
        : []
    ]);

    const targets = new Map<string, string>();
    for (const p of products) targets.set(p.id, p.trashedAt ? `${p.title} (in the bin)` : p.title);
    for (const v of variants) targets.set(v.id, `${v.product.title} — ${variantLabel(v)}`);
    return { targets, locations: new Map(locations.map(l => [l.id, l.name])) };
  }

  /**
   * One offer, and whether it worked.
   *
   * "Sales made" is the total of the orders that used it, not the extra sales it caused -- nobody
   * can know the second, and a number that pretends to is worse than none.
   */
  async detail(clientId: string, id: string) {
    const offer = await offerService.getById(clientId, id);

    // Every id any version ever named, so history can name things the offer no longer holds.
    const snapshots = offer.versions.map(v => v.snapshot as any);
    const allRefs = [
      ...offer.targets.map(t => ({ scope: t.scope as string, refId: t.refId })),
      ...offer.exclusions.map(t => ({ scope: t.scope as string, refId: t.refId })),
      ...snapshots.flatMap(s => [...(s?.targets ?? []), ...(s?.exclusions ?? [])] as { scope: string; refId: string }[])
    ];
    const allLocations = [...new Set([...offer.locationIds, ...snapshots.flatMap(s => (s?.locationIds ?? []) as string[])])];

    const [labels, uses, released, orderTotals, users, locationRows, codeRows] = await Promise.all([
      this.labels(clientId, allRefs, allLocations),
      prisma.offerRedemption.findMany({
        where: { clientId, offerId: id },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, salesOrderId: true, customerId: true, amount: true, status: true, createdAt: true }
      }),
      prisma.offerRedemption.count({ where: { clientId, offerId: id, status: 'RELEASED' } }),
      prisma.$queryRaw<{ total: Prisma.Decimal | null; customers: bigint }[]>`
        SELECT COALESCE(SUM(so.total), 0) AS total, COUNT(DISTINCT r.customer_id) AS customers
          FROM offer_redemptions r
          JOIN sales_orders so ON so.id = r.sales_order_id
         WHERE r.client_id = ${clientId} AND r.offer_id = ${id} AND r.status = 'COUNTED'`,
      prisma.user.findMany({
        where: { id: { in: [...new Set(offer.versions.map(v => v.changedBy).filter(Boolean) as string[])] } },
        select: { id: true, name: true }
      }),
      prisma.stockLocation.findMany({ where: { clientId, id: { in: offer.locationIds } }, select: { id: true, name: true, active: true } }),
      offer.uniqueCodes
        ? Promise.all([
            prisma.offerCode.count({ where: { offerId: id } }),
            prisma.offerCode.count({ where: { offerId: id, usedAt: { not: null } } })
          ])
        : Promise.resolve(null)
    ]);

    const spentCodes = uses.length
      ? await prisma.salesOrderDiscount.findMany({
          where: { offerId: id, salesOrderId: { in: uses.map(u => u.salesOrderId) }, code: { not: null } },
          select: { salesOrderId: true, code: true }
        })
      : [];
    const codeOfOrder = new Map(spentCodes.map(c => [c.salesOrderId, c.code]));

    const orders = uses.length
      ? await prisma.salesOrder.findMany({
          where: { clientId, id: { in: uses.map(u => u.salesOrderId) } },
          select: { id: true, orderNumber: true, customerName: true, total: true, status: true, channel: true, customer: { select: { name: true } } }
        })
      : [];
    const orderById = new Map(orders.map(o => [o.id, o]));
    const userById = new Map(users.map(u => [u.id, u.name]));

    // Newest first, each described against the one before it.
    const history = offer.versions.map((v, i) => {
      const previous = offer.versions[i + 1];
      return {
        id: v.id,
        version: v.version,
        createdAt: v.createdAt,
        changedBy: v.changedBy ? (userById.get(v.changedBy) ?? 'A former user') : null,
        note: v.changeNote,
        changes: previous ? describeChanges(previous.snapshot as any, v.snapshot as any, labels) : []
      };
    });

    const { versions: _versions, ...rest } = offer as any;
    const totals = orderTotals[0];
    const nameOf = (t: { scope: string; refId: string }) =>
      t.scope === 'CATEGORY' ? (DEPARTMENTS.find(d => d.value === t.refId)?.label ?? t.refId)
        : t.scope === 'DRESS_TYPE' ? t.refId
        : (labels.targets.get(t.refId) ?? 'An item that was removed');

    return {
      ...rest,
      targets: offer.targets.map(t => ({
        scope: t.scope,
        refId: t.refId,
        label: t.scope === 'CATEGORY' ? (DEPARTMENTS.find(d => d.value === t.refId)?.label ?? t.refId)
          : t.scope === 'DRESS_TYPE' ? t.refId
          : (labels.targets.get(t.refId) ?? 'An item that was removed'),
        missing: (t.scope === 'PRODUCT' || t.scope === 'VARIANT') && !labels.targets.has(t.refId)
      })),
      exclusions: offer.exclusions.map(t => ({
        scope: t.scope,
        refId: t.refId,
        label: nameOf(t as any),
        missing: (t.scope === 'PRODUCT' || t.scope === 'VARIANT') && !labels.targets.has(t.refId)
      })),
      codes: codeRows ? { total: codeRows[0], used: codeRows[1], unused: codeRows[0] - codeRows[1] } : null,
      locations: offer.locationIds.map(lid => {
        const row = locationRows.find(l => l.id === lid);
        return { id: lid, name: row?.name ?? 'A removed location', active: row?.active ?? false };
      }),
      stats: {
        timesUsed: offer.redemptionCount,
        givenBack: released,
        totalDiscounted: offer.totalDiscounted,
        salesMade: totals?.total ?? new Prisma.Decimal(0),
        customers: Number(totals?.customers ?? 0),
        usesLeft: offer.usageLimit == null ? null : Math.max(0, offer.usageLimit - offer.usageCount)
      },
      recentUses: uses.map(u => {
        const order = orderById.get(u.salesOrderId);
        return {
          id: u.id,
          orderId: u.salesOrderId,
          orderNumber: order?.orderNumber ?? null,
          // The name typed on the bill if there was one, else the customer it belongs to.
          customerName: order?.customerName || order?.customer?.name || null,
          orderTotal: order?.total ?? null,
          orderStatus: order?.status ?? null,
          channel: order?.channel ?? null,
          amount: u.amount,
          code: codeOfOrder.get(u.salesOrderId) ?? null,
          status: u.status,
          createdAt: u.createdAt
        };
      }),
      history
    };
  }
}

export const offerInsightService = new OfferInsightService();
