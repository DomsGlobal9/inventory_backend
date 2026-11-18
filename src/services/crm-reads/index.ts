/**
 * What ScaleEzy CRM reads from Inventory through internal routes, so it never reads Inventory's tables
 * (18 Nov 2026, the owner: "everything module should talk by apis"). All read only, one shop at a time:
 *
 *   profile()     the shop as it signs a message: name, phone, email, address, logo, timezone.
 *   shopLink()    its online shop: address, open or not.
 *   linksFor()    product or colour codes -> the page on the online shop.
 *   newArrivals() colours received from suppliers in a window (CRM's arrivals message).
 *   productLikes() online-shop hearts on products; photosOf() one product's photos.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { shopBaseUrl } from '../online-shop/shop.service';
import { badRequest, notFound } from '../../utils/httpError';

const DAY = 86_400_000;

export async function profile(clientId: string) {
  const [s, cs] = await Promise.all([
    getShopSettings(clientId),
    prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true, businessPhone: true, businessEmail: true, businessAddress: true, logoUrl: true } })
  ]);
  return {
    name: cs?.businessName ?? null,
    phone: cs?.businessPhone ?? null,
    email: cs?.businessEmail ?? null,
    address: cs?.businessAddress ?? null,
    logoUrl: cs?.logoUrl ?? null,
    timezone: s.timezone
  };
}

/** The online shop's address, or null when the shop has none. baseUrl null: shop pages not set up on this server. */
export async function shopLink(clientId: string) {
  const shop = await prisma.onlineShop.findUnique({ where: { clientId }, select: { slug: true, isLive: true } });
  if (!shop) return null;
  const base = shopBaseUrl()?.replace(/\/+$/, '') ?? null;
  return { slug: shop.slug, isLive: shop.isLive, url: base ? `${base}/${shop.slug}` : null };
}

/**
 * Codes -> pages. A product code, or a colour's code / SKU (which opens its product). Archived, binned or
 * another shop's codes come back with url null, so CRM never sends a link to a page that is not there.
 */
export async function linksFor(clientId: string, rawCodes: unknown) {
  const codes = [...new Set(String(rawCodes ?? '').split(',').map(c => c.trim()).filter(Boolean))];
  if (!codes.length) throw badRequest('Say which codes: codes=<code>,<code> (up to 200).');
  if (codes.length > 200) throw badRequest('Ask for at most 200 codes at a time.');
  const link = await shopLink(clientId);
  const live = { status: { notIn: ['ARCHIVED', 'TRASHED'] as any } };
  const [products, variants] = await Promise.all([
    prisma.product.findMany({ where: { clientId, productCode: { in: codes }, ...live }, select: { productCode: true } }),
    prisma.productVariant.findMany({
      where: { clientId, boutiqueDeletedAt: null, OR: [{ variantCode: { in: codes } }, { sku: { in: codes } }], product: live },
      select: { variantCode: true, sku: true, product: { select: { productCode: true } } }
    })
  ]);
  const page = new Map<string, string>();
  for (const p of products) page.set(p.productCode, p.productCode);
  for (const v of variants) for (const c of [v.variantCode, v.sku]) if (c && !page.has(c)) page.set(c, v.product.productCode);
  return {
    shop: link,
    links: codes.map(code => {
      const productCode = page.get(code) ?? null;
      return { code, productCode, url: productCode && link?.url && link.isLive ? `${link.url}/p/${encodeURIComponent(productCode)}` : null };
    })
  };
}

/**
 * Stock RECEIVED from suppliers in a window (purchase receipts), one row per colour received, newest first:
 * what CRM's new-arrivals message says. Kind is the shop's own word for the garment (dress type); size and
 * colour are the colour's own, else what the receipt line said. receivedAt is the latest receipt in the
 * window. Archived and binned products are left out (a message must not point at them).
 */
export async function newArrivals(clientId: string, query: any) {
  const when = (raw: unknown, what: string) => {
    const d = new Date(String(raw ?? ''));
    if (raw === undefined || Number.isNaN(d.getTime())) throw badRequest(`Send ${what} as a date and time (ISO), e.g. 2026-11-18T00:00:00+05:30.`);
    return d;
  };
  const from = when(query?.from, 'from');
  const to = query?.to === undefined ? new Date() : when(query.to, 'to');
  if (to <= from) throw badRequest('to must be after from.');
  if (to.getTime() - from.getTime() > 92 * DAY) throw badRequest('Ask for at most 92 days at a time.');
  const rows = await prisma.$queryRaw<{ variant_id: string; product_id: string; title: string; kind: string | null; slug: string; size: string | null; colour: string | null; received_at: Date }[]>`
    SELECT v.id AS variant_id, p.id AS product_id, p.title, p.dress_type AS kind, p.slug,
           COALESCE(NULLIF(v.size, ''), MAX(i.size)) AS size, COALESCE(NULLIF(v.color_name, ''), MAX(i.color)) AS colour,
           MAX(r.received_at) AS received_at
      FROM purchase_receipts r
      JOIN purchase_receipt_items i ON i.receipt_id = r.id
      JOIN inventory_product_variants v ON v.id = i.variant_id
      JOIN inventory_products p ON p.id = v.product_id
     WHERE r.client_id = ${clientId} AND v.client_id = ${clientId} AND p.client_id = ${clientId}
       AND i.quantity > 0 AND r.received_at >= ${from} AND r.received_at < ${to}
       AND p.status::text NOT IN ('ARCHIVED', 'TRASHED') AND v.boutique_deleted_at IS NULL
     GROUP BY v.id, p.id
     ORDER BY received_at DESC, v.id
     LIMIT 1001`;
  return {
    from, to,
    hasMore: rows.length > 1000,
    pieces: rows.slice(0, 1000).map(r => ({
      variantId: r.variant_id, productId: r.product_id, title: r.title, kind: r.kind, slug: r.slug,
      size: r.size, colour: r.colour, receivedAt: r.received_at
    }))
  };
}

const ids200 = (raw: unknown, what: string) => {
  const ids = [...new Set(String(raw ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length) throw badRequest(`Say which ${what}: ?productIds=<id>,<id> (up to 200).`);
  if (ids.length > 200) throw badRequest('Ask for at most 200 at a time.');
  if (ids.some(id => !/^[0-9a-f-]{36}$/.test(id))) throw badRequest('Every id must be a product id from Inventory.');
  return ids;
};

/** Online-shop hearts on these products: who (their proved number), which product, which colour. */
export async function productLikes(clientId: string, rawIds: unknown) {
  const productIds = ids200(rawIds, 'products');
  const rows = await prisma.shopProductView.findMany({
    where: { clientId, productId: { in: productIds }, likedAt: { not: null } },
    select: { phone: true, productId: true, variantId: true, likedAt: true },
    orderBy: { likedAt: 'desc' }
  });
  const vids = [...new Set(rows.map(r => r.variantId).filter((x): x is string => !!x))];
  const colours = vids.length ? await prisma.productVariant.findMany({ where: { clientId, id: { in: vids } }, select: { id: true, colorName: true } }) : [];
  return rows.map(r => ({ phone: r.phone, productId: r.productId, colour: colours.find(c => c.id === r.variantId)?.colorName ?? null, likedAt: r.likedAt }));
}

/** One product's photos (cover and gallery, not raw uploads), primary and then in their order. */
export async function photosOf(clientId: string, productId: string) {
  const id = String(productId ?? '').toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw badRequest('That is not a product id from Inventory.');
  const product = await prisma.product.findFirst({ where: { id, clientId }, select: { id: true } });
  if (!product) throw notFound('That product was not found.');
  const images = await prisma.productImage.findMany({
    where: { imageType: { in: ['COVER', 'GALLERY'] as any }, OR: [{ productId: id }, { variant: { productId: id, clientId } }] },
    select: { url: true, variantId: true, isPrimary: true, orderIndex: true, variant: { select: { colorName: true } } },
    orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }]
  });
  return images.map(i => ({ url: i.url, variantId: i.variantId, colour: i.variant?.colorName ?? null, isPrimary: i.isPrimary, orderIndex: i.orderIndex }));
}
