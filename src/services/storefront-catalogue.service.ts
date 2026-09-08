import { getShopSettings } from '../lib/clientSettings';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';

/**
 * What a storefront is allowed to see, and what it means.
 *
 * Every rule about storefront visibility lives here, once. The alternative -- exposing internal
 * objects and letting each website re-implement "is this sellable" -- guarantees that each one
 * gets it slightly differently wrong, and that a change to the rule silently stops applying to
 * anyone who already integrated.
 *
 * Two things this file owns:
 *
 *   ELIGIBILITY   which products and variants a storefront may see at all
 *   SCOPE         which locations' stock and prices it sees them through
 *
 * Scope is not a refinement. VariantLocationProfile carries isAvailable AND priceOverride per
 * location, so in this product stock and price are both properties of a variant AT a location.
 * A merchant with a back-office warehouse and a retail shop has no single answer to "what does
 * the website show", so the connection states it and everything here reads it.
 */

export interface CatalogueScope {
  clientId: string;
  /** Empty means every location the tenant has. */
  locationIds: string[];
}

export interface StorefrontVariant {
  sku: string;
  variantCode: string;
  barcode: string | null;
  size: string | null;
  colour: string | null;
  price: number;
  compareAtPrice: number | null;
  currency: string;
  stock: {
    quantity: number;
    reserved: number;
    available: number;
    sellable: boolean;
  };
}

export interface StorefrontProduct {
  productCode: string;
  title: string;
  description: string | null;
  category: string;
  productType: string;
  dressType: string | null;
  fabric: string | null;
  brand: string | null;
  publishedAt: string | null;
  updatedAt: string;
  images: { url: string; isPrimary: boolean; position: number }[];
  variants: StorefrontVariant[];
}

/**
 * A product is visible to a storefront when the merchant has published it and it is not
 * archived or in the bin.
 *
 * ACTIVE is what "published" means here. The wizard maps its publish switch straight to the
 * status (`isPublished ? 'ACTIVE' : 'DRAFT'`), and nothing in the application has ever written
 * `publishedAt` -- all 13 ACTIVE products carry null. Requiring that column would have shown
 * every storefront an empty catalogue forever, with nothing to indicate why. It is now set
 * going forward, for storefronts that want to sort by newest, but it is not what decides
 * visibility.
 *
 * Stock is deliberately not part of this: something out of stock is still a real product, and
 * whether to show it is the storefront's decision, made from `sellable` rather than by us
 * hiding the product and leaving a dead link behind.
 */
const ELIGIBLE_PRODUCT: Prisma.ProductWhereInput = {
  status: 'ACTIVE',
  trashedAt: null
};

/**
 * The same rule, applied to a product already in hand rather than as a query.
 *
 * Kept immediately beside ELIGIBLE_PRODUCT because the two must agree: when they were written
 * separately they drifted within the hour, and the symptom was a product visible in the read
 * API while every event about it was silently discarded -- a storefront that could see it but
 * would never be told when it changed.
 */
function isEligible(product: { status: string; trashedAt: Date | null }): boolean {
  return product.status === 'ACTIVE' && product.trashedAt === null;
}

/** Locations in scope, resolved once. An empty scope means all of the tenant's locations. */
async function resolveLocationIds(scope: CatalogueScope): Promise<string[]> {
  if (scope.locationIds.length > 0) return scope.locationIds;
  const all = await prisma.stockLocation.findMany({
    where: { clientId: scope.clientId, active: true },
    select: { id: true }
  });
  return all.map(l => l.id);
}

/**
 * Price for a variant through a scope.
 *
 * A location may override the price (`VariantLocationProfile.priceOverride`). With several
 * locations in scope and different overrides, the lowest is used: it is the price a shopper
 * could actually obtain, and quoting a higher one they cannot get is the worse error.
 */
function resolvePrice(
  variant: { sellingPrice: Prisma.Decimal | null; product: { basePrice: Prisma.Decimal } },
  profiles: { locationId: string; priceOverride: Prisma.Decimal | null }[],
  scopedLocationIds: Set<string>
): number {
  const overrides = profiles
    .filter(p => scopedLocationIds.has(p.locationId) && p.priceOverride !== null)
    .map(p => Number(p.priceOverride));

  if (overrides.length > 0) return Math.min(...overrides);
  if (variant.sellingPrice !== null) return Number(variant.sellingPrice);
  return Number(variant.product.basePrice);
}

/**
 * Stock through a scope, stated rather than left to be derived.
 *
 * `available` is quantity minus what is already promised to someone else. A storefront that
 * subtracts reservations itself will eventually forget to, and oversell.
 *
 * `sellable` additionally requires the variant to be marked available at a scoped location.
 * A variant with no profile row for a location is available there -- `isAvailable` defaults to
 * true, so absence means "nobody has said otherwise", not "hidden".
 */
function resolveStock(
  stocks: { locationId: string; quantity: number; reservedQty: number }[],
  profiles: { locationId: string; isAvailable: boolean }[],
  scopedLocationIds: Set<string>
) {
  let quantity = 0;
  let reserved = 0;
  for (const s of stocks) {
    if (!scopedLocationIds.has(s.locationId)) continue;
    quantity += s.quantity;
    reserved += s.reservedQty;
  }

  const blocked = new Set(
    profiles.filter(p => !p.isAvailable).map(p => p.locationId)
  );
  const availableSomewhere = [...scopedLocationIds].some(id => !blocked.has(id));

  const available = Math.max(quantity - reserved, 0);
  return { quantity, reserved, available, sellable: availableSomewhere && available > 0 };
}

const VARIANT_SELECT = {
  sku: true,
  variantCode: true,
  barcode: true,
  size: true,
  colorName: true,
  sellingPrice: true,
  compareAtPrice: true,
  stocks: { select: { locationId: true, quantity: true, reservedQty: true } },
  locationProfiles: { select: { locationId: true, isAvailable: true, priceOverride: true } }
} as const;

function toStorefrontVariant(
  variant: any,
  basePrice: Prisma.Decimal,
  scopedLocationIds: Set<string>,
  currency: string
): StorefrontVariant {
  return {
    sku: variant.sku,
    variantCode: variant.variantCode,
    barcode: variant.barcode ?? null,
    size: variant.size ?? null,
    colour: variant.colorName ?? null,
    price: resolvePrice({ sellingPrice: variant.sellingPrice, product: { basePrice } },
      variant.locationProfiles, scopedLocationIds),
    compareAtPrice: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
    currency,
    stock: resolveStock(variant.stocks, variant.locationProfiles, scopedLocationIds)
  };
}

export class StorefrontCatalogueService {
  /**
   * The shop's currency, stated on every price so a receiver never has to assume.
   *
   * Cached, because this sat on the path of a merchant's own website loading its products:
   * a full round trip to another continent, roughly a second, to fetch the string "INR" --
   * paid by a shopper waiting for the page.
   */
  async getCurrency(clientId: string): Promise<string> {
    return (await getShopSettings(clientId)).currency;
  }

  /**
   * A page of the catalogue.
   *
   * Cursor-based rather than offset-based, and ordered by `[updatedAt, id]`, which gives three
   * things at once: a stable page boundary while products are being edited underneath, an
   * initial sync that can resume after an interruption instead of restarting, and -- with a
   * cursor from last time -- an incremental "what changed since" read. Offset pagination gives
   * none of these; rows shift between pages as the catalogue changes and items are silently
   * skipped.
   */
  async listProducts(scope: CatalogueScope, opts: { cursor?: string; limit?: number; since?: Date } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    // Together, not one after the other. Neither needs the other's answer, and waiting for the
    // locations before even asking for the currency spent a whole round trip -- about a second
    // from here -- on nothing. That second is paid by a shopper waiting for the page.
    const [locationIds, currency] = await Promise.all([
      resolveLocationIds(scope),
      this.getCurrency(scope.clientId)
    ]);
    const scoped = new Set(locationIds);

    const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;

    const where: Prisma.ProductWhereInput = {
      clientId: scope.clientId,
      ...ELIGIBLE_PRODUCT,
      ...(opts.since ? { updatedAt: { gte: opts.since } } : {}),
      ...(decoded
        ? {
            OR: [
              { updatedAt: { gt: decoded.updatedAt } },
              { updatedAt: decoded.updatedAt, id: { gt: decoded.id } }
            ]
          }
        : {})
    };

    const rows = await prisma.product.findMany({
      where,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1, // one extra, purely to know whether another page exists
      select: {
        id: true, productCode: true, title: true, description: true,
        category: true, productType: true, dressType: true, fabric: true, brand: true,
        basePrice: true, publishedAt: true, updatedAt: true,
        images: {
          select: { url: true, isPrimary: true, orderIndex: true },
          where: { imageType: { in: ['COVER', 'GALLERY'] } },
          orderBy: { orderIndex: 'asc' }
        },
        variants: { select: VARIANT_SELECT }
      }
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const products: StorefrontProduct[] = page.map(p => ({
      productCode: p.productCode,
      title: p.title,
      description: p.description ?? null,
      category: String(p.category),
      productType: String(p.productType),
      dressType: p.dressType ?? null,
      fabric: p.fabric ?? null,
      brand: p.brand ?? null,
      publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
      updatedAt: p.updatedAt.toISOString(),
      images: p.images.map(i => ({ url: i.url, isPrimary: i.isPrimary, position: i.orderIndex })),
      variants: p.variants.map(v => toStorefrontVariant(v, p.basePrice, scoped, currency))
    }));

    const last = page[page.length - 1];
    return {
      products,
      hasMore,
      // Present even on the last page: a storefront stores it and passes it back later as
      // `since` to ask what has changed, which is how reconciliation and recovery work.
      nextCursor: last ? encodeCursor(last.updatedAt, last.id) : (opts.cursor ?? null)
    };
  }

  /** One product by its public code, for a storefront filling a gap it noticed. */
  async getProduct(scope: CatalogueScope, productCode: string): Promise<StorefrontProduct | null> {
    // Together, not one after the other. Neither needs the other's answer, and waiting for the
    // locations before even asking for the currency spent a whole round trip -- about a second
    // from here -- on nothing. That second is paid by a shopper waiting for the page.
    const [locationIds, currency] = await Promise.all([
      resolveLocationIds(scope),
      this.getCurrency(scope.clientId)
    ]);
    const scoped = new Set(locationIds);

    const p = await prisma.product.findFirst({
      where: { clientId: scope.clientId, productCode, ...ELIGIBLE_PRODUCT },
      select: {
        productCode: true, title: true, description: true,
        category: true, productType: true, dressType: true, fabric: true, brand: true,
        basePrice: true, publishedAt: true, updatedAt: true,
        images: {
          select: { url: true, isPrimary: true, orderIndex: true },
          where: { imageType: { in: ['COVER', 'GALLERY'] } },
          orderBy: { orderIndex: 'asc' }
        },
        variants: { select: VARIANT_SELECT }
      }
    });
    if (!p) return null;

    return {
      productCode: p.productCode,
      title: p.title,
      description: p.description ?? null,
      category: String(p.category),
      productType: String(p.productType),
      dressType: p.dressType ?? null,
      fabric: p.fabric ?? null,
      brand: p.brand ?? null,
      publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
      updatedAt: p.updatedAt.toISOString(),
      images: p.images.map(i => ({ url: i.url, isPrimary: i.isPrimary, position: i.orderIndex })),
      variants: p.variants.map(v => toStorefrontVariant(v, p.basePrice, scoped, currency))
    };
  }

  /**
   * The stock half of a variant, through a scope. Used when raising a stock event, so an event
   * and the read API can never disagree about what "available" means.
   */
  async variantStockForScope(scope: CatalogueScope, variantId: string) {
    const locationIds = await resolveLocationIds(scope);
    const scoped = new Set(locationIds);

    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, clientId: scope.clientId },
      select: {
        sku: true,
        product: { select: { productCode: true, status: true, trashedAt: true } },
        stocks: { select: { locationId: true, quantity: true, reservedQty: true } },
        locationProfiles: { select: { locationId: true, isAvailable: true, priceOverride: true } }
      }
    });
    if (!variant) return null;

    return {
      sku: variant.sku,
      productCode: variant.product.productCode,
      /**
       * Whether the storefront should be told about this at all.
       *
       * Must stay the same rule as ELIGIBLE_PRODUCT above. Having written it twice, it
       * immediately drifted -- this copy still demanded publishedAt after the query stopped
       * doing so, which made the read API show a product while events about it were silently
       * dropped. Expressed against the same fields so the two are checkable side by side.
       */
      eligible: isEligible(variant.product),
      stock: resolveStock(variant.stocks, variant.locationProfiles, scoped)
    };
  }
}

/**
 * Cursors are opaque to the caller by design -- base64 of `updatedAt|id` -- so the pagination
 * key can change later without every integrator having built a dependency on its shape.
 */
function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const updatedAt = new Date(iso);
    if (!id || Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

export const storefrontCatalogueService = new StorefrontCatalogueService();
