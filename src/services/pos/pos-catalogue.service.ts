/**
 * The catalogue as a till needs it.
 *
 * This is the storefront feed with four tax fields and integer paise, not a second catalogue. The
 * storefront feed already solved the hard parts -- scoping to a connection's locations, the
 * per-location price override, `available` as quantity minus what is promised to someone else,
 * and the cursor/`since` paging a sync client needs. Writing a second one would mean two answers
 * to "what does this variant cost here", and they would disagree the first time somebody changed
 * one of them.
 *
 * WHAT A TILL NEEDS THAT A WEBSITE DOES NOT:
 *
 *   hsn, taxRateBps      every bill line must carry them, and a website never prints a bill
 *   taxSlabbed           so the POS can warn when a stitched piece over Rs 2,500 is set to 5%
 *   priceIsExclusive     whether the shop typed the price with tax in it or not
 *   pricePaise           an integer. A till adds and splits money thousands of times a day and
 *                        cannot afford a float doing it
 *
 * THE RATE IS USED AS GIVEN. Whatever the shop typed on the product is what gets charged --
 * nothing here works a rate out from a price. That was settled on the owner's instruction, and it
 * removed a case with no answer: a stitched piece priced inclusive of tax between Rs 2,625 and
 * Rs 2,950 was above the Rs 2,500 threshold at 5% and below it at 18%.
 */

import { prisma } from '../../lib/prisma';
import { storefrontCatalogueService, type CatalogueScope } from '../storefront-catalogue.service';
import { toMinor } from '../pricing/money';

export interface PosVariantTax {
  hsn: string | null;
  taxRateBps: number | null;
  taxSlabbed: boolean;
  priceIsExclusive: boolean;
}

/**
 * The tax standing of every variant in a page, in one query.
 *
 * Per-variant lookups would be a query per line of a catalogue sync, which for a shop with four
 * hundred sarees is four hundred round trips to Singapore. The variant's own code wins over the
 * product's, because a saree sold with a stitched blouse is two different things on one invoice.
 */
async function taxByVariantCode(
  clientId: string,
  variantCodes: string[]
): Promise<Map<string, PosVariantTax>> {
  if (!variantCodes.length) return new Map();

  const rows = await prisma.productVariant.findMany({
    where: { clientId, variantCode: { in: variantCodes } },
    select: {
      variantCode: true,
      hsnCode: true,
      taxRateBps: true,
      product: {
        select: { hsnCode: true, taxRateBps: true, taxSlabbed: true, priceIsExclusive: true }
      }
    }
  });

  return new Map(rows.map(v => [v.variantCode, {
    hsn: v.hsnCode ?? v.product.hsnCode ?? null,
    taxRateBps: v.taxRateBps ?? v.product.taxRateBps ?? null,
    taxSlabbed: Boolean(v.product.taxSlabbed),
    priceIsExclusive: Boolean(v.product.priceIsExclusive)
  }]));
}

/** One page of the catalogue, with tax and integer paise on every variant. */
export async function listForPos(
  scope: CatalogueScope,
  paging: { cursor?: string; limit?: number; since?: Date }
) {
  const page = await storefrontCatalogueService.listProducts(scope, paging);

  const codes = page.products.flatMap((p: any) => p.variants.map((v: any) => v.variantCode));
  const tax = await taxByVariantCode(scope.clientId, codes);

  const products = page.products.map((p: any) => ({
    ...p,
    variants: p.variants.map((v: any) => {
      const t = tax.get(v.variantCode) ?? {
        hsn: null, taxRateBps: null, taxSlabbed: false, priceIsExclusive: false
      };
      return {
        ...v,
        /*
         * Integer paise beside the rupee figure rather than instead of it. The storefront's own
         * `price` stays exactly as it was, because the online shop reads this same feed and a
         * changed field there is a changed price on a live page.
         */
        pricePaise: toMinor(v.price),
        compareAtPricePaise: v.compareAtPrice == null ? null : toMinor(v.compareAtPrice),
        hsn: t.hsn,
        taxRateBps: t.taxRateBps,
        taxSlabbed: t.taxSlabbed,
        priceIsExclusive: t.priceIsExclusive,
        /*
         * Can a till sell this right now? A product that left the catalogue since the last sync
         * appears on an incremental page with eligible:false, so the till stops offering it
         * rather than quietly keeping a copy nobody deleted.
         */
        eligible: Boolean(v.stock?.sellable)
      };
    })
  }));

  return { ...page, products };
}

/**
 * Live availability for a handful of codes.
 *
 * Separate from the catalogue because they change at completely different rates: a name or an HSN
 * changes about never, and a quantity changes every time anybody sells anything. A till caches the
 * first hard and asks for the second when it matters -- which is the last few pieces, not every
 * keystroke.
 */
export async function stockForPos(scope: CatalogueScope, variantCodes: string[]) {
  const wanted = [...new Set(variantCodes.map(c => String(c).trim()).filter(Boolean))].slice(0, 200);
  if (!wanted.length) return [];

  const locationIds = scope.locationIds;

  const variants = await prisma.productVariant.findMany({
    where: { clientId: scope.clientId, variantCode: { in: wanted } },
    select: {
      variantCode: true,
      sku: true,
      product: { select: { isService: true } },
      stocks: {
        where: locationIds.length ? { locationId: { in: locationIds } } : undefined,
        select: { quantity: true, reservedQty: true, locationId: true }
      }
    }
  });

  return variants.map(v => {
    // A service keeps no count: null, as in the catalogue, never 0 ("none left").
    if (v.product.isService) return { variantCode: v.variantCode, sku: v.sku, quantity: null, reserved: null, available: null };
    const quantity = v.stocks.reduce((s, r) => s + r.quantity, 0);
    const reserved = v.stocks.reduce((s, r) => s + r.reservedQty, 0);
    return {
      variantCode: v.variantCode,
      sku: v.sku,
      quantity,
      reserved,
      // What a till may actually promise a customer standing in front of it.
      available: Math.max(0, quantity - reserved)
    };
  });
}
