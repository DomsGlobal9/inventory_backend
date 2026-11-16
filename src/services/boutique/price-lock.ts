import { prisma } from '../../lib/prisma';

/**
 * A product the boutique created is the boutique's (owner, 13 Nov 2026: "the price added in the boutique is the price
 * used for selling in the shops"; 16 Nov: lock its details too, so the shop's screens and CRM-B never fight).
 * Inventory shows it but cannot change what the boutique sends on every save -- the name, the price, how it is sold,
 * its GST, its colours -- nor delete or add colours; the boutique changes them and they land here. What the boutique
 * only sends sometimes (description, brand, material, reorder level) stays editable here, and so do the shop's own
 * choices (published or not, the online-shop category, cut rules, photos added by the shop). GST, rounding and
 * offers still apply on our side, as for every product.
 */
export const BOUTIQUE_PRICE_MESSAGE = 'This price comes from your boutique. Change it there and it updates here by itself.';
export const BOUTIQUE_DETAILS_MESSAGE = 'comes from your boutique app. Change it there and it updates here by itself.';

/** Equal for a person: blank, null and missing are one; numbers by value; text without outer spaces. */
function same(a: unknown, b: unknown) {
  const norm = (v: unknown) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
  const x = norm(a), y = norm(b);
  if (x === null || y === null) return x === y;
  const nx = Number(x), ny = Number(y);
  if (typeof x !== 'boolean' && typeof y !== 'boolean' && Number.isFinite(nx) && Number.isFinite(ny) && String(x).trim() !== '' && String(y).trim() !== '') return nx === ny;
  return String(x).trim() === String(y).trim();
}

const PRODUCT_LOCKED: Record<string, string> = {
  title: 'The name', soldBy: 'How it is sold', kind: 'The kind', widthCm: 'The width',
  productType: 'The garment type', hsnCode: 'The HSN code', taxRateBps: 'The GST rate'
};
const refuse = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

/** Refuse a change to a boutique-owned product's price or details. Other fields stay editable. */
export async function guardProductPrice(clientId: string, productId: string, data: Record<string, unknown>) {
  const asked = Object.keys(PRODUCT_LOCKED).filter(k => data[k] !== undefined);
  if (data.basePrice === undefined && !asked.length) return;
  const p: any = await prisma.product.findFirst({ where: { id: productId, clientId } });
  if (p?.priceOwner !== 'BOUTIQUE') return;
  if (data.basePrice !== undefined && !same(data.basePrice, p.basePrice)) throw refuse(BOUTIQUE_PRICE_MESSAGE);
  for (const k of asked) if (!same(data[k], p[k])) throw refuse(`${PRODUCT_LOCKED[k]} ${BOUTIQUE_DETAILS_MESSAGE}`);
}

const VARIANT_LOCKED: Record<string, string> = { colorName: 'The colour', hexCode: 'The colour', size: 'The size', costPrice: 'The purchase price' };

/** Refuse a change to a boutique-owned colour's price, MRP, colour, size or purchase price. Reorder level and the rest stay editable. */
export async function guardVariantPrice(clientId: string, where: { id?: string; sku?: string }, data: Record<string, unknown>) {
  const asked = Object.keys(VARIANT_LOCKED).filter(k => data[k] !== undefined);
  if (data.sellingPrice === undefined && data.compareAtPrice === undefined && data.priceOverride === undefined && !asked.length) return;
  const v: any = await prisma.productVariant.findFirst({ where: { clientId, ...where }, include: { product: { select: { priceOwner: true } } } });
  if (v?.product.priceOwner !== 'BOUTIQUE') return;
  if ((data.sellingPrice !== undefined && !same(data.sellingPrice, v.sellingPrice)) || (data.compareAtPrice !== undefined && !same(data.compareAtPrice, v.compareAtPrice))
    || (data.priceOverride !== undefined && !same(data.priceOverride, v.compareAtPrice))) throw refuse(BOUTIQUE_PRICE_MESSAGE);
  for (const k of asked) if (!same(data[k], v[k])) throw refuse(`${VARIANT_LOCKED[k]} ${BOUTIQUE_DETAILS_MESSAGE}`);
}

/** A boutique colour is archived in the boutique app, never deleted here: its stock, holds and history belong to the boutique's orders. */
export async function guardColourDelete(clientId: string, variantId: string) {
  const v = await prisma.productVariant.findFirst({ where: { id: variantId, clientId }, select: { boutiqueRef: true } });
  if (v?.boutiqueRef) throw refuse('This colour comes from your boutique app, so it cannot be deleted here. Archive it in the boutique app.');
}

/** Colours of a boutique design are added in the boutique app, which gives each its item code. */
export function guardNewColours(product: { priceOwner?: string | null }) {
  if (product?.priceOwner === 'BOUTIQUE') throw refuse('The colours of this item come from your boutique app. Add the colour there and it appears here by itself.');
}
