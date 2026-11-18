/**
 * What ScaleEzy CRM reads from Inventory through internal routes, so it never reads Inventory's tables
 * (18 Nov 2026, the owner: "everything module should talk by apis"). All read only, one shop at a time:
 *
 *   profile()     the shop as it signs a message: name, phone, email, address, logo, timezone.
 *   shopLink()    its online shop: address, open or not.
 *   linksFor()    product or colour codes -> the page on the online shop.
 *   newArrivals() pieces that came into stock lately, with stock, price and photos (CRM's arrivals message).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { shopBaseUrl } from '../online-shop/shop.service';
import { badRequest } from '../../utils/httpError';

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
 * Colours that came into stock in the last `days` days and still have stock, newest first, 50 a page.
 * "Came into stock" is the first stock that ever came in for that colour (its first inward movement), or
 * when it was made if it was added with stock and no movement. Archived and binned products are left out.
 */
export async function newArrivals(clientId: string, query: any) {
  const days = query?.days === undefined ? 14 : Number(query.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw badRequest('days must be a whole number from 1 to 90.');
  const page = query?.page === undefined ? 1 : Number(query.page);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw badRequest('page must be a whole number from 1.');
  const size = 50;
  const since = new Date(Date.now() - days * DAY);
  const rows = await prisma.$queryRaw<{ variant_id: string; product_id: string; title: string; category: string; size: string | null; colour: string | null; price: Prisma.Decimal | null; stock: bigint; first_in: Date }[]>`
    SELECT v.id AS variant_id, v.product_id, p.title, p.category::text AS category, v.size, v.color_name AS colour,
           v.selling_price AS price, s.stock, COALESCE(t.first_in, v.created_at) AS first_in
      FROM inventory_product_variants v
      JOIN inventory_products p ON p.id = v.product_id
      JOIN (SELECT variant_id, SUM(quantity) AS stock FROM inventory_stocks WHERE client_id = ${clientId} GROUP BY variant_id HAVING SUM(quantity) > 0) s
        ON s.variant_id = v.id
      LEFT JOIN (SELECT variant_id, MIN(created_at) AS first_in FROM inventory_transactions WHERE client_id = ${clientId} AND quantity > 0 GROUP BY variant_id) t
        ON t.variant_id = v.id
     WHERE v.client_id = ${clientId} AND p.client_id = ${clientId} AND v.boutique_deleted_at IS NULL
       AND p.status::text NOT IN ('ARCHIVED', 'TRASHED')
       AND COALESCE(t.first_in, v.created_at) >= ${since}
     ORDER BY first_in DESC, v.id
     LIMIT ${size + 1} OFFSET ${(page - 1) * size}`;
  const pieces = rows.slice(0, size);
  const productIds = [...new Set(pieces.map(r => r.product_id))];
  const images = productIds.length ? await prisma.productImage.findMany({
    where: { OR: [{ productId: { in: productIds } }, { variant: { productId: { in: productIds } } }] },
    select: { url: true, productId: true, variantId: true, isPrimary: true, orderIndex: true, variant: { select: { productId: true, colorName: true } } },
    orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }]
  }) : [];
  return {
    days, page,
    hasMore: rows.length > size,
    pieces: pieces.map(r => ({
      variantId: r.variant_id,
      productId: r.product_id,
      title: r.title,
      kind: r.category,
      size: r.size,
      colour: r.colour,
      price: r.price === null ? null : Number(r.price),
      stock: Number(r.stock),
      firstInStockAt: r.first_in,
      photos: images.filter(i => (i.productId ?? i.variant?.productId) === r.product_id)
        .map(i => ({ url: i.url, variantId: i.variantId, colour: i.variant?.colorName ?? null, isPrimary: i.isPrimary }))
    }))
  };
}
