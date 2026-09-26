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
import { badRequest, notFound } from '../../utils/httpError';
import { effectiveStatus } from './rules';
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
  /**
   * How many products each offer actually covers.
   *
   * A merchant writes "20% off sarees", switches it on, and watches nothing happen -- because
   * their products carry no dress type, so the offer matches not one piece in the shop. It ran
   * for a week and discounted nothing, and there was nowhere at all this could be seen: the
   * offer said ACTIVE, the dates were right, and it was simply pointed at an empty shelf.
   *
   * The picker already says "Sarees (42)" while an offer is being written. This is the same
   * question asked about one that is already running, which is when it matters most.
   *
   * One pass over three small columns rather than a query per offer: a shop with a thousand
   * products is three thousand short strings, and the offers screen is a screen somebody opens,
   * not a path anything hot goes down.
   */
  async coverage(
    clientId: string,
    offers: { id: string; scope: string; targets: { scope: string; refId: string }[]; exclusions: { scope: string; refId: string }[] }[]
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (offers.length === 0) return out;

    const products = await prisma.product.findMany({
      where: { clientId, ...onSale },
      select: { id: true, category: true, dressType: true }
    });

    // Only loaded when an offer actually names pieces; most never do.
    const variantProduct = new Map<string, string>();
    const namesVariants = offers.some(
      o => o.scope === 'VARIANT' || o.exclusions.some(e => e.scope === 'VARIANT')
    );
    if (namesVariants) {
      const vs = await prisma.productVariant.findMany({ where: { clientId }, select: { id: true, productId: true } });
      for (const v of vs) variantProduct.set(v.id, v.productId);
    }

    /** The same rules the pricing engine matches by, asked of a product rather than a basket line. */
    const hits = (
      ref: { scope: string; refId: string },
      p: { id: string; category: string | null; dressType: string | null }
    ): boolean => {
      switch (ref.scope) {
        case 'CATEGORY': return p.category === ref.refId;
        // Free text a person typed, so matched the way a person reads it.
        case 'DRESS_TYPE': return !!p.dressType && normaliseType(ref.refId) === normaliseType(p.dressType);
        case 'PRODUCT': return ref.refId === p.id;
        case 'VARIANT': return variantProduct.get(ref.refId) === p.id;
        default: return false;
      }
    };

    for (const o of offers) {
      let n = 0;
      for (const p of products) {
        // An exclusion beats any target, as it does in the engine.
        if (o.exclusions.some(e => hits(e, p))) continue;
        if (o.scope === 'ALL' || o.targets.some(t => hits({ scope: o.scope, refId: t.refId }, p))) n++;
      }
      out.set(o.id, n);
    }
    return out;
  }

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
    const HISTORY_SHOWN = 20;
    /*
     * Two rounds of queries, each in parallel.
     *
     * This page used to ask the database in five rounds, one after another -- the offer, its totals,
     * its uses, their orders, their codes -- and with the database on another continent that was
     * over three seconds before the page could draw anything. Everything that does not depend on
     * the offer's own contents is asked for at once, joined in SQL where it can be.
     */
    const [offer, statRows, useRows, codeRows] = await Promise.all([
      prisma.offer.findFirst({
        where: { id, clientId },
        include: { targets: true, exclusions: true, versions: { orderBy: { version: 'desc' }, take: HISTORY_SHOWN + 1 } }
      }),
      prisma.$queryRaw<{ used: bigint; given: Prisma.Decimal | null; released: bigint; sales: Prisma.Decimal | null; customers: bigint }[]>`
        SELECT COUNT(*) FILTER (WHERE r.status = 'COUNTED')                     AS used,
               COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'COUNTED'), 0)   AS given,
               COUNT(*) FILTER (WHERE r.status = 'RELEASED')                    AS released,
               COALESCE(SUM(so.total) FILTER (WHERE r.status = 'COUNTED'), 0)   AS sales,
               COUNT(DISTINCT r.customer_id) FILTER (WHERE r.status = 'COUNTED') AS customers
          FROM offer_redemptions r
          LEFT JOIN sales_orders so ON so.id = r.sales_order_id
         WHERE r.client_id = ${clientId} AND r.offer_id = ${id}`,
      prisma.$queryRaw<{
        id: string; sales_order_id: string; amount: Prisma.Decimal; status: string; created_at: Date;
        order_number: string | null; customer_name: string | null; account_name: string | null;
        total: Prisma.Decimal | null; order_status: string | null; channel: string | null; code: string | null
      }[]>`
        SELECT r.id, r.sales_order_id, r.amount, r.status, r.created_at,
               so.order_number, so.customer_name, c.name AS account_name, so.total,
               so.status::text AS order_status, so.channel::text AS channel,
               (SELECT d.code FROM sales_order_discounts d
                 WHERE d.sales_order_id = r.sales_order_id AND d.offer_id = r.offer_id AND d.code IS NOT NULL
                 LIMIT 1) AS code
          FROM offer_redemptions r
          LEFT JOIN sales_orders so ON so.id = r.sales_order_id
          LEFT JOIN customers c ON c.id = so.customer_id
         WHERE r.client_id = ${clientId} AND r.offer_id = ${id}
         ORDER BY r.created_at DESC
         LIMIT 25`,
      prisma.$queryRaw<{ total: bigint; used: bigint }[]>`
        SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE used_at IS NOT NULL) AS used
          FROM offer_codes WHERE client_id = ${clientId} AND offer_id = ${id}`
    ]);
    if (!offer) throw notFound('That offer no longer exists.');

    // Every id any version ever named, so history can name things the offer no longer holds.
    const snapshots = offer.versions.map(v => v.snapshot as any);
    const allRefs = [
      ...offer.targets.map(t => ({ scope: t.scope as string, refId: t.refId })),
      ...offer.exclusions.map(t => ({ scope: t.scope as string, refId: t.refId })),
      ...snapshots.flatMap(s => [...(s?.targets ?? []), ...(s?.exclusions ?? [])] as { scope: string; refId: string }[])
    ];
    const allLocations = [...new Set([...offer.locationIds, ...snapshots.flatMap(s => (s?.locationIds ?? []) as string[])])];

    const [labels, users, locationRows] = await Promise.all([
      this.labels(clientId, allRefs, allLocations),
      prisma.user.findMany({
        where: { id: { in: [...new Set(offer.versions.map(v => v.changedBy).filter(Boolean) as string[])] } },
        select: { id: true, name: true }
      }),
      offer.locationIds.length
        ? prisma.stockLocation.findMany({ where: { clientId, id: { in: offer.locationIds } }, select: { id: true, name: true, active: true } })
        : Promise.resolve([] as { id: string; name: string; active: boolean }[])
    ]);

    const st = statRows[0];
    const userById = new Map(users.map(u => [u.id, u.name]));

    // Newest first, each described against the one before it.
    // One more version is loaded than is shown, so the oldest one shown can still be compared with
    // the one before it rather than saying it changed nothing.
    const history = offer.versions.slice(0, HISTORY_SHOWN).map((v, i) => {
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
      codes: offer.uniqueCodes
        ? { total: Number(codeRows[0]?.total ?? 0), used: Number(codeRows[0]?.used ?? 0), unused: Number(codeRows[0]?.total ?? 0) - Number(codeRows[0]?.used ?? 0) }
        : null,
      locations: offer.locationIds.map(lid => {
        const row = locationRows.find(l => l.id === lid);
        return { id: lid, name: row?.name ?? 'A removed location', active: row?.active ?? false };
      }),
      // Same shape as before: counts as numbers, money as decimals.
      redemptionCount: Number(st?.used ?? 0),
      totalDiscounted: st?.given ?? new Prisma.Decimal(0),
      effectiveStatus: effectiveStatus(offer as any),
      stats: {
        timesUsed: Number(st?.used ?? 0),
        givenBack: Number(st?.released ?? 0),
        totalDiscounted: st?.given ?? new Prisma.Decimal(0),
        salesMade: st?.sales ?? new Prisma.Decimal(0),
        customers: Number(st?.customers ?? 0),
        usesLeft: offer.usageLimit == null ? null : Math.max(0, offer.usageLimit - offer.usageCount)
      },
      recentUses: useRows.map(u => ({
        id: u.id,
        orderId: u.sales_order_id,
        orderNumber: u.order_number,
        // The name typed on the bill if there was one, else the customer it belongs to.
        customerName: u.customer_name || u.account_name || null,
        orderTotal: u.total,
        orderStatus: u.order_status,
        channel: u.channel,
        amount: u.amount,
        code: u.code,
        status: u.status,
        createdAt: u.created_at
      })),
      history
    };
  }
}

export const offerInsightService = new OfferInsightService();
