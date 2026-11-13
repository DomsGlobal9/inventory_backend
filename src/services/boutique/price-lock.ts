import { prisma } from '../../lib/prisma';

/**
 * A product the boutique created keeps the boutique's price (owner, 13 Nov 2026: "the price added in the boutique is
 * the price used for selling in the shops"). Inventory shows it but cannot change it; the boutique changes it and it
 * lands here. GST, rounding and offers still apply on our side, as for every product.
 */
export const BOUTIQUE_PRICE_MESSAGE = 'This price comes from your boutique. Change it there and it updates here by itself.';

const differs = (a: unknown, b: unknown) => a !== undefined && Number(a ?? NaN) !== Number(b ?? NaN);

/** Refuse a change to a boutique-owned product's selling price (basePrice). Other fields stay editable. */
export async function guardProductPrice(clientId: string, productId: string, data: { basePrice?: unknown }) {
  if (data.basePrice === undefined) return;
  const p = await prisma.product.findFirst({ where: { id: productId, clientId }, select: { priceOwner: true, basePrice: true } });
  if (p?.priceOwner === 'BOUTIQUE' && differs(data.basePrice, p.basePrice)) throw Object.assign(new Error(BOUTIQUE_PRICE_MESSAGE), { statusCode: 409 });
}

/** Refuse a change to a boutique-owned colour's selling price or MRP. Cost, reorder level and the rest stay editable. */
export async function guardVariantPrice(clientId: string, where: { id?: string; sku?: string }, data: { sellingPrice?: unknown; compareAtPrice?: unknown; priceOverride?: unknown }) {
  if (data.sellingPrice === undefined && data.compareAtPrice === undefined && data.priceOverride === undefined) return;
  const v = await prisma.productVariant.findFirst({ where: { clientId, ...where }, select: { sellingPrice: true, compareAtPrice: true, product: { select: { priceOwner: true } } } });
  if (v?.product.priceOwner !== 'BOUTIQUE') return;
  if (differs(data.sellingPrice, v.sellingPrice) || differs(data.compareAtPrice, v.compareAtPrice) || differs(data.priceOverride, v.compareAtPrice)) {
    throw Object.assign(new Error(BOUTIQUE_PRICE_MESSAGE), { statusCode: 409 });
  }
}
