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
  /**
   * Show every photograph a product has, including the flat-lay references a generated set was
   * made from. Off unless asked, so the sync feed a merchant's website reads never changes shape
   * under it.
   */
  allPhotos?: boolean;
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
  /** The shade the shop recorded for this colour, as #rrggbb, or null if it did not record one. */
  colourHex: string | null;
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
  images: { url: string; isPrimary: boolean; position: number; variantCode: string | null; kind: string }[];
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
export const ELIGIBLE_PRODUCT: Prisma.ProductWhereInput = {
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

/*
 * A colour is going into `style="background: ..."` on a page, so only a real hex leaves here.
 * Shops type these by hand: "#8B1A2B", "8b1a2b" and "#8b1a2b " are all meant, and anything that
 * is not a colour at all becomes null rather than something a browser has to guess at.
 */
function normaliseHex(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : '';
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(v)) return null;
  const full = v.length === 3 ? v.split('').map(c => c + c).join('') : v;
  return `#${full.toLowerCase()}`;
}

const VARIANT_SELECT = {
  id: true,
  sku: true,
  variantCode: true,
  barcode: true,
  size: true,
  colorName: true,
  // The shade the shop recorded against this variant. A saree shop's "Maroon" is its own maroon,
  // and a swatch guessed from the word is a different colour from the one in the photograph.
  hexCode: true,
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
    colourHex: normaliseHex(variant.hexCode),
    price: resolvePrice({ sellingPrice: variant.sellingPrice, product: { basePrice } },
      variant.locationProfiles, scopedLocationIds),
    compareAtPrice: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
    currency,
    stock: resolveStock(variant.stocks, variant.locationProfiles, scopedLocationIds)
  };
}

/**
 * Everything a product page needs, in one place.
 *
 * The sync feed, the shopper's browse and the single-product read must all return the same shape:
 * when the select was written out at each call site they drifted, and a field added for one was
 * quietly missing from the others.
 */
const PRODUCT_SELECT = {
  id: true, productCode: true, title: true, description: true,
  category: true, productType: true, dressType: true, fabric: true, brand: true,
  basePrice: true, publishedAt: true, createdAt: true, updatedAt: true,
  images: {
    // variantId: a photograph may belong to one colour rather than to the product as a whole,
    // which is how a shop shows the green saree when green is chosen.
    //
    // imageType comes back so the CALLER can decide. RAW_UPLOAD is the flat-lay Try-On generated a
    // product's views from; a merchant's own website has always received only the finished ones and
    // still does, while a shop that wants to show everything it uploaded can say so. Filtering here
    // meant neither could choose.
    select: { url: true, isPrimary: true, orderIndex: true, variantId: true, imageType: true },
    orderBy: { orderIndex: 'asc' as const }
  },
  variants: { select: VARIANT_SELECT }
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>;

/**
 * One row, as everything outside this service sees it.
 *
 * `allPhotos` defaults to false so that every existing caller -- above all a merchant's own website
 * reading the sync feed -- receives exactly what it always has: the finished photographs only.
 * The shop's own page passes true unless its owner has said otherwise.
 */
function toStorefrontProduct(
  p: ProductRow, scoped: Set<string>, currency: string, allPhotos = false
): StorefrontProduct {
  const byVariantId = new Map(p.variants.map(v => [v.id, v.variantCode]));
  const shown = allPhotos
    ? p.images
    : p.images.filter(i => i.imageType === 'COVER' || i.imageType === 'GALLERY');
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
    /*
     * `variantCode` rather than the variant's id, because a receiver outside this building should
     * never need one of our ids to make sense of an answer -- the code is what it already has.
     */
    images: shown.map(i => ({
      url: i.url,
      isPrimary: i.isPrimary,
      position: i.orderIndex,
      variantCode: i.variantId ? (byVariantId.get(i.variantId) ?? null) : null,
      /** COVER, GALLERY, or the RAW_UPLOAD a generated set was made from. */
      kind: String(i.imageType)
    })),
    variants: p.variants.map(v => toStorefrontVariant(v, p.basePrice, scoped, currency))
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
      select: PRODUCT_SELECT
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    /*
     * The sync feed keeps the shape it has always had, deliberately: a merchant's own website is
     * built against these photographs, and quietly adding flat-lay references to it would put a
     * garment on a table onto somebody's product page without them asking.
     */
    const products: StorefrontProduct[] = page.map(p => toStorefrontProduct(p, scoped, currency));

    const last = page[page.length - 1];
    return {
      products,
      hasMore,
      // Present even on the last page: a storefront stores it and passes it back later as
      // `since` to ask what has changed, which is how reconciliation and recovery work.
      nextCursor: last ? encodeCursor(last.updatedAt, last.id) : (opts.cursor ?? null)
    };
  }

  /**
   * The catalogue as a SHOPPER browses it, for the shop's own online shop.
   *
   * Deliberately not `listProducts` with extra arguments. That one is a synchronisation feed: it
   * is ordered by `updatedAt` so a website can page through with a cursor and later ask "what
   * changed since". Ordered that way, a shopper's first page is whatever the shop last edited,
   * which means nothing to them. So this asks a different question of the same data -- and shares
   * everything that must not diverge: which products are eligible, the variant shape, the prices
   * and stock for the scope, and the mapping.
   *
   * Offset paging rather than a cursor, because a shopper jumps to page 3 and back, and the set
   * they are paging is filtered and sorted by their own choices, not by a changing clock.
   */
  async browseProducts(scope: CatalogueScope, opts: {
    q?: string; category?: string; fabric?: string; dressType?: string;
    minPrice?: number; maxPrice?: number;
    sort?: 'NEW' | 'PRICE_LOW' | 'PRICE_HIGH' | 'NAME';
    page?: number; limit?: number;
  } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 24, 1), 48);
    const page = Math.max(Number(opts.page) || 1, 1);
    const [locationIds, currency] = await Promise.all([
      resolveLocationIds(scope),
      this.getCurrency(scope.clientId)
    ]);
    const scoped = new Set(locationIds);

    const q = (opts.q ?? '').trim().slice(0, 60);
    const where: Prisma.ProductWhereInput = {
      clientId: scope.clientId,
      ...ELIGIBLE_PRODUCT,
      ...(opts.category ? { category: opts.category as never } : {}),
      ...(opts.fabric ? { fabric: { equals: opts.fabric, mode: 'insensitive' } } : {}),
      ...(opts.dressType ? { dressType: { equals: opts.dressType, mode: 'insensitive' } } : {}),
      ...(opts.minPrice != null || opts.maxPrice != null
        ? { basePrice: { ...(opts.minPrice != null ? { gte: opts.minPrice } : {}), ...(opts.maxPrice != null ? { lte: opts.maxPrice } : {}) } }
        : {}),
      // What a shopper actually types: a name, a fabric, a colour, or the code off a tag.
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { fabric: { contains: q, mode: 'insensitive' } },
              { dressType: { contains: q, mode: 'insensitive' } },
              { brand: { contains: q, mode: 'insensitive' } },
              { productCode: { contains: q, mode: 'insensitive' } },
              { variants: { some: { colorName: { contains: q, mode: 'insensitive' } } } }
            ]
          }
        : {})
    };

    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      opts.sort === 'PRICE_LOW' ? [{ basePrice: 'asc' }, { id: 'asc' }]
      : opts.sort === 'PRICE_HIGH' ? [{ basePrice: 'desc' }, { id: 'asc' }]
      : opts.sort === 'NAME' ? [{ title: 'asc' }, { id: 'asc' }]
      // Newest first is what a returning customer wants to see, and what "new arrivals" means.
      : [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }];

    const [total, rows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        select: PRODUCT_SELECT
      })
    ]);

    return {
      products: rows.map(p => toStorefrontProduct(p, scoped, currency, scope.allPhotos === true)),
      page,
      limit,
      total,
      hasMore: page * limit < total
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
      select: PRODUCT_SELECT
    });
    if (!p) return null;
    return toStorefrontProduct(p, scoped, currency, scope.allPhotos === true);
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
