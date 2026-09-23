import { prisma } from '../../lib/prisma';
import { ELIGIBLE_PRODUCT } from '../storefront-catalogue.service';

/**
 * What this shop actually sells, read from the shop's own catalogue.
 *
 * Every list a shopper can choose from -- the categories in the nav, the fabrics on the filter
 * rail, what kind of thing it is, the brands, the range the prices run over -- is computed here
 * from the client's live products. Nothing is hard-coded and nothing is a guess: a shop that has
 * never sold a lehenga has no Lehengas in its nav, and the day it adds one, it does.
 *
 * This replaces a real bug. The filter rail used to be built from whichever products happened to
 * be on the page being looked at, so a shop with sixty pieces showed the fabrics of the first
 * twenty-four, and choosing page two changed the filters underneath the shopper's hand.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Facets }>();

export type Facets = {
  categories: { value: string; label: string; count: number }[];
  dressTypes: { value: string; count: number }[];
  fabrics: { value: string; count: number }[];
  brands: { value: string; count: number }[];
  price: { min: number; max: number } | null;
  total: number;
};

/**
 * Categories are an enum in the database (WOMEN, MEN, KIDS...), which is not how a shopper reads
 * a nav bar. The word is made from the value rather than kept in a table, because the enum is the
 * only place the set is decided and a second list would drift from it.
 */
const label = (value: string) =>
  value.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');

/**
 * Sorted by how much of it the shop has, then alphabetically.
 *
 * A saree shop whose catalogue is nine-tenths sarees should have Sarees first in its nav; sorting
 * these alphabetically would put its one Blouse ahead of them.
 */
const rank = (rows: { value: string; count: number }[]) =>
  rows.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

export async function facetsFor(
  clientId: string,
  scope: { locationIds: string[]; hideOutOfStock: boolean }
): Promise<Facets> {
  const key = `${clientId}|${[...scope.locationIds].sort().join(',')}|${scope.hideOutOfStock}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  /*
   * Only what a shopper could actually reach, using the CATALOGUE'S OWN rule rather than a second
   * copy of it, so the nav can never offer a category whose page turns out to be empty.
   *
   * Written out by hand, this said `publishedAt: { not: null }` -- and every facet came back empty,
   * because in this database `publishedAt` is null on products that are very much on sale. The
   * comment above ELIGIBLE_PRODUCT warns about precisely that; importing it is the only way the
   * two cannot drift.
   */
  const where: any = { ...ELIGIBLE_PRODUCT, clientId };

  /*
   * A shop that hides what it has sold out of should not have those things in its nav either.
   *
   * This parameter was passed in and never used, so a shop with "hide sold out" on could show
   * "Lehengas (3)" in its filter rail and then an empty page -- the exact dead end the facets were
   * built to prevent. "Sellable" here means stock the shop actually sells online: some at one of
   * its chosen stores, and not blocked there.
   */
  if (scope.hideOutOfStock && scope.locationIds.length) {
    where.variants = {
      some: {
        stocks: { some: { locationId: { in: scope.locationIds }, quantity: { gt: 0 } } },
        NOT: { locationProfiles: { some: { locationId: { in: scope.locationIds }, isAvailable: false } } }
      }
    };
  }

  const [byCategory, byDressType, byFabric, byBrand, span, total] = await Promise.all([
    prisma.product.groupBy({ by: ['category'], where, _count: { _all: true } }),
    prisma.product.groupBy({ by: ['dressType'], where: { ...where, dressType: { not: null } }, _count: { _all: true } }),
    prisma.product.groupBy({ by: ['fabric'], where: { ...where, fabric: { not: null } }, _count: { _all: true } }),
    prisma.product.groupBy({ by: ['brand'], where: { ...where, brand: { not: null } }, _count: { _all: true } }),
    /*
     * The range the shop's prices actually run over, so a price filter offers figures that exist.
     * Read from the variants' own selling prices, falling back to the product's base price the same
     * way the catalogue resolves a price -- a slider that started at zero because one variant had
     * no price of its own would be a slider nobody could use.
     */
    prisma.productVariant.aggregate({
      where: { clientId, sellingPrice: { not: null, gt: 0 }, product: where },
      _min: { sellingPrice: true },
      _max: { sellingPrice: true }
    }),
    prisma.product.count({ where })
  ]);

  const value: Facets = {
    categories: rank(byCategory.map(r => ({ value: String(r.category), count: r._count._all })))
      .map(r => ({ ...r, label: label(r.value) })),
    dressTypes: rank(byDressType.map(r => ({ value: String(r.dressType), count: r._count._all }))),
    fabrics: rank(byFabric.map(r => ({ value: String(r.fabric), count: r._count._all }))),
    brands: rank(byBrand.map(r => ({ value: String(r.brand), count: r._count._all }))),
    price: span._min.sellingPrice === null || span._max.sellingPrice === null
      ? null
      : {
        // Rounded outwards to round figures, because "₹980 to ₹11,200" on a slider reads like a
        // mistake where "₹900 to ₹11,500" reads like a range.
        min: Math.floor(Number(span._min.sellingPrice) / 100) * 100,
        max: Math.ceil(Number(span._max.sellingPrice) / 100) * 100
      },
    total
  };

  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Called when a shop's catalogue changes under it, so the nav is not a minute stale. */
export function forgetFacets(clientId: string) {
  for (const key of cache.keys()) if (key.startsWith(`${clientId}|`)) cache.delete(key);
}
