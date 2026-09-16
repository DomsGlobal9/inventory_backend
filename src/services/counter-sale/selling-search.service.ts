import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../utils/httpError';
import { resolveVariantForLocation } from '../../utils/variant-location';

/**
 * Finding an item to sell, at one store.
 *
 * Its own search rather than /variants/search, for two reasons that are both about the person at
 * the counter. That search returns what the shop paid and every store's stock, and a salesperson is
 * not meant to see either -- SALES has no inventory:view and no cost:view. And a counter needs a
 * different answer: the price at THIS store and how many are free HERE, because that is what the
 * customer in front of them can buy.
 *
 * A scanner types the barcode and presses Enter, so an exact barcode, SKU or code is answered on its
 * own (`exact: true`) and the screen adds it straight to the basket. Anything else is a list.
 */

const LIMIT = 25;

const variantSelect = (locationId: string) => ({
  id: true,
  sku: true,
  variantCode: true,
  barcode: true,
  colorName: true,
  hexCode: true,
  size: true,
  sellingPrice: true,
  compareAtPrice: true,
  product: {
    select: {
      id: true, title: true, productCode: true, basePrice: true,
      images: { where: { variantId: null }, orderBy: [{ isPrimary: 'desc' as const }, { orderIndex: 'asc' as const }], take: 1, select: { url: true } }
    }
  },
  images: { orderBy: [{ isPrimary: 'desc' as const }, { orderIndex: 'asc' as const }], take: 1, select: { url: true } },
  locationProfiles: { where: { locationId } },
  stocks: { where: { locationId }, select: { quantity: true, reservedQty: true } }
});

/** Products a shop has retired are not for sale, wherever they are typed. */
const sellable = { trashedAt: null, status: { notIn: ['ARCHIVED', 'TRASHED'] as any } };

function shape(variant: any, locationId: string) {
  const at = resolveVariantForLocation(variant, locationId, Number(variant.product.basePrice));
  const stock = variant.stocks[0];
  const onShelf = stock?.quantity ?? 0;
  const held = stock?.reservedQty ?? 0;
  return {
    variantId: variant.id,
    productId: variant.product.id,
    title: variant.product.title,
    sku: variant.sku,
    code: variant.variantCode,
    barcode: variant.barcode,
    colorName: variant.colorName,
    hexCode: variant.hexCode,
    size: variant.size,
    imageUrl: variant.images[0]?.url ?? variant.product.images[0]?.url ?? null,
    price: at.price,
    compareAtPrice: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
    // Stopped at this store (Settings -> per-store availability). Shown, but not sellable.
    sellableHere: at.isAvailable && at.price !== null,
    onShelf,
    held,
    available: Math.max(0, onShelf - held)
  };
}

export async function searchSellableItems(clientId: string, locationId: string | undefined, rawQuery: unknown) {
  if (!locationId) throw badRequest('Choose the store you are selling from.');
  const store = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { active: true, name: true } });
  if (!store) throw notFound('That store was not found.');
  if (!store.active) throw badRequest(`${store.name} is closed, so it cannot sell.`);

  const q = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 80) : '';
  if (!q) return { exact: false, items: [] };

  // A scanned or typed code: one item, straight into the basket.
  const exact = await prisma.productVariant.findMany({
    where: {
      clientId,
      product: sellable,
      OR: [
        { barcode: q },
        { sku: { equals: q, mode: 'insensitive' } },
        { variantCode: { equals: q, mode: 'insensitive' } }
      ]
    },
    select: variantSelect(locationId),
    take: 2
  });
  if (exact.length === 1) return { exact: true, items: [shape(exact[0], locationId)] };

  // Every word has to match something: "red silk m" narrows, rather than widening to everything red.
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const matches = await prisma.productVariant.findMany({
    where: {
      clientId,
      product: sellable,
      AND: words.map(word => ({
        OR: [
          { product: { title: { contains: word, mode: 'insensitive' as const } } },
          { product: { productCode: { contains: word, mode: 'insensitive' as const } } },
          { sku: { contains: word, mode: 'insensitive' as const } },
          { variantCode: { contains: word, mode: 'insensitive' as const } },
          { colorName: { contains: word, mode: 'insensitive' as const } },
          { size: { equals: word, mode: 'insensitive' as const } }
        ]
      }))
    },
    select: variantSelect(locationId),
    orderBy: [{ product: { title: 'asc' } }, { sku: 'asc' }],
    take: LIMIT
  });

  const items = matches.map(v => shape(v, locationId));
  // What can be sold here first; a list led by things out of stock is a list scrolled past.
  items.sort((a, b) => Number(b.sellableHere && b.available > 0) - Number(a.sellableHere && a.available > 0));
  return { exact: false, items };
}
