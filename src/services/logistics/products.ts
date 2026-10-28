import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { effectiveTaxFor } from '../pricing/hsn';
import { inclusiveFromTaxable, mayChargeTax, registrationInForce } from '../pricing/tax';

/**
 * Products by SKU, for ScaleEzy Logistics (28 Oct): the Logistics module's order form fills an item
 * from a SKU -- name, final price, GST rate, HSN, stock -- for a shipment that has no order here.
 * (Shipping an Inventory order goes from the order itself, packed and weighed; this is the lookup for
 * everything else, and what their autocomplete reads.)
 *
 * The shape is the one Logistics asked for (snake_case, numbers not strings, null when unknown --
 * never "" or 0 for a value we do not have):
 *
 *   selling_price  the FINAL price per unit, GST included -- the same rule as the Shopify push
 *                  (shopify-products/render.ts withFinalPrices): a price entered without GST has
 *                  it added; a shop that charges no GST adds nothing.
 *   tax_rate       % as the shop typed it on the product (or variant); 0 for a shop that charges no
 *                  GST; null for a registered shop that has not set it yet.
 *   weight/size    null: Inventory does not keep a packed weight per product. The packed, weighed
 *                  parcel of an Inventory order carries its real weight and box instead.
 *   stock_quantity what can be sold now (on hand less held), all stores, or the one asked for.
 *
 * SKU matching: exact first; if nothing, the same SKU in another letter case when exactly one SKU in
 * this shop matches that way. One shop's products only -- every query is by clientId.
 */

const MAX_MANY = 50;
const MAX_SEARCH = 25;

const variantSelect = {
  id: true, sku: true, size: true, colorName: true, sellingPrice: true, compareAtPrice: true,
  hsnCode: true, taxRateBps: true, updatedAt: true,
  images: { orderBy: [{ isPrimary: 'desc' as const }, { orderIndex: 'asc' as const }, { createdAt: 'asc' as const }], take: 1, select: { url: true } },
  product: {
    select: {
      id: true, title: true, productCode: true, category: true, dressType: true, description: true,
      basePrice: true, hsnCode: true, taxRateBps: true, taxSlabbed: true, priceIsExclusive: true,
      status: true, trashedAt: true, updatedAt: true,
      images: { orderBy: [{ isPrimary: 'desc' as const }, { orderIndex: 'asc' as const }, { createdAt: 'asc' as const }], take: 1, select: { url: true } }
    }
  }
} satisfies Prisma.ProductVariantSelect;
type Row = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;

const money = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));
const rupees = (paise: number) => Math.round(paise) / 100;

async function shopChargesTax(clientId: string) {
  const s = await prisma.clientSettings.findUnique({ where: { clientId }, select: { gstRegistration: true, gstNumber: true } });
  return mayChargeTax(registrationInForce(s?.gstRegistration, s?.gstNumber));
}

async function stockOf(clientId: string, variantIds: string[], locationId?: string) {
  if (!variantIds.length) return new Map<string, { total: number; byStore: { location_id: string; name: string; available: number }[] }>();
  const rows = await prisma.inventoryStock.findMany({
    where: { variantId: { in: variantIds }, location: { clientId, ...(locationId ? { id: locationId } : {}) } },
    select: { variantId: true, quantity: true, reservedQty: true, location: { select: { id: true, name: true } } }
  });
  const out = new Map<string, { total: number; byStore: { location_id: string; name: string; available: number }[] }>();
  for (const r of rows) {
    const available = Math.max(0, r.quantity - r.reservedQty);
    const e = out.get(r.variantId) ?? { total: 0, byStore: [] };
    e.total += available;
    e.byStore.push({ location_id: r.location.id, name: r.location.name, available });
    out.set(r.variantId, e);
  }
  return out;
}

function shape(v: Row, chargesTax: boolean, stock: { total: number; byStore: { location_id: string; name: string; available: number }[] } | undefined) {
  const p = v.product;
  const tax = effectiveTaxFor(p, v);
  const rateBps = chargesTax ? tax.taxRateBps : 0;
  const entered = money(v.sellingPrice) ?? money(p.basePrice);
  // GST added for a price entered without it, exactly as the till and the Shopify push do.
  const final = (price: number | null) => {
    if (price === null || !Number.isFinite(price)) return null;
    if (!chargesTax || !p.priceIsExclusive || !rateBps || rateBps <= 0) return price;
    return rupees(inclusiveFromTaxable(Math.round(price * 100), rateBps));
  };
  const nameParts = [v.colorName, v.size && v.size.toLowerCase() !== 'free' ? v.size : null].filter(Boolean);
  const updated = v.updatedAt > p.updatedAt ? v.updatedAt : p.updatedAt;
  return {
    sku: v.sku,
    name: nameParts.length ? `${p.title} - ${nameParts.join(' / ')}` : p.title,
    selling_price: final(entered),
    mrp: final(money(v.compareAtPrice)),
    discount: 0,
    tax_rate: rateBps === null ? null : rateBps / 100,
    hsn_code: tax.hsnCode,
    weight_kg: null,
    length_cm: null,
    breadth_cm: null,
    height_cm: null,
    stock_quantity: stock?.total ?? 0,
    stock_by_location: stock?.byStore ?? [],
    is_active: p.status === 'ACTIVE' && !p.trashedAt,
    variant: { size: v.size ?? null, color: v.colorName ?? null },
    image_url: v.images[0]?.url ?? p.images[0]?.url ?? null,
    category: p.dressType ?? (p.category ? String(p.category) : null),
    description: p.description ?? null,
    product_code: p.productCode,
    pickup_location: null,
    cod_allowed: null,
    is_fragile: null,
    updated_at: updated.toISOString()
  };
}

/** One product by SKU, or null. */
export async function bySku(clientId: string, rawSku: unknown, locationId?: string) {
  const sku = typeof rawSku === 'string' ? rawSku.trim() : '';
  if (!sku || sku.length > 100) return null;
  const found = (await many(clientId, [sku], locationId)).products;
  return found[0] ?? null;
}

/** Several SKUs at once: { products, not_found }, in the order asked, each SKU once. */
export async function many(clientId: string, rawSkus: unknown, locationId?: string) {
  const asked = [...new Set((Array.isArray(rawSkus) ? rawSkus : String(rawSkus ?? '').split(','))
    .map(s => String(s).trim()).filter(s => s && s.length <= 100))].slice(0, MAX_MANY);
  if (!asked.length) return { products: [], not_found: [] as string[] };

  const exact = await prisma.productVariant.findMany({ where: { clientId, sku: { in: asked } }, select: variantSelect });
  const bySkuExact = new Map(exact.map(v => [v.sku, v]));
  const missing = asked.filter(s => !bySkuExact.has(s));
  const loose = new Map<string, Row>();
  for (const s of missing) {
    const hits = await prisma.productVariant.findMany({ where: { clientId, sku: { equals: s, mode: 'insensitive' } }, select: variantSelect, take: 2 });
    if (hits.length === 1) loose.set(s, hits[0]);   // two would be a guess
  }
  const rows = asked.map(s => bySkuExact.get(s) ?? loose.get(s) ?? null);
  const found = rows.filter((r): r is Row => !!r);
  const [chargesTax, stock] = await Promise.all([shopChargesTax(clientId), stockOf(clientId, found.map(r => r.id), locationId)]);
  return {
    products: found.map(r => shape(r, chargesTax, stock.get(r.id))),
    not_found: asked.filter((_, i) => !rows[i])
  };
}

/** For an autocomplete: SKU, name, price, picture. Matches SKU, title, colour or product code. */
export async function search(clientId: string, rawQ: unknown, rawLimit?: unknown) {
  const typed = typeof rawQ === 'string' ? rawQ.trim().slice(0, 60) : '';
  if (typed.length < 2) return [];
  // Prisma's `contains` is a LIKE and does not escape: "%" or "_" typed would match everything.
  const q = typed.replace(/[\\%_]/g, '\\$&');
  const limit = Math.min(Math.max(Number(rawLimit) || 10, 1), MAX_SEARCH);
  const rows = await prisma.productVariant.findMany({
    where: {
      clientId,
      product: { status: 'ACTIVE', trashedAt: null },
      OR: [
        { sku: { contains: q, mode: 'insensitive' } },
        { colorName: { contains: q, mode: 'insensitive' } },
        { product: { title: { contains: q, mode: 'insensitive' } } },
        { product: { productCode: { contains: q, mode: 'insensitive' } } }
      ]
    },
    orderBy: [{ product: { title: 'asc' } }, { sku: 'asc' }],
    take: limit,
    select: variantSelect
  });
  const chargesTax = await shopChargesTax(clientId);
  return rows.map(r => {
    const s = shape(r, chargesTax, undefined);
    return { sku: s.sku, name: s.name, selling_price: s.selling_price, image_url: s.image_url, variant: s.variant };
  });
}
