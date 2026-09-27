/**
 * The tax figures that get written onto a sale line and never worked out again.
 *
 * Separated from the order service because the POS will need exactly this, and because it is easy
 * to test on its own -- the order service is not.
 *
 * IT RECORDS, IT DOES NOT POLICE. A shop that has not set an HSN yet still sells, and the line
 * simply carries nulls, which is what every row in the table holds today. Refusing belongs where a
 * DOCUMENT is produced -- `buildBill`'s `issuable` -- not where an order is saved. Putting the
 * refusal here would stop every shop selling the moment it deployed, to fix a problem none of them
 * has noticed yet.
 */

import { taxForLine, taxableFromInclusive, rateFor, type RateRule } from './tax';
import { Prisma } from '@prisma/client';
import { fromMinor } from './money';

export interface ProductTaxStanding {
  hsnCode: string | null;
  taxRateBps: number | null;
  taxSlabbed: boolean;
  priceIsExclusive: boolean;
}

interface PricedEnough {
  quantity: number;
  unitPriceMinor: number;
  totalPriceMinor: number;
}

/**
 * Rupees, as Decimal columns, because every other money column on sales_order_items already is --
 * listUnitPrice, unitPrice, totalPrice. These started as BigInt paise, which is exactly right for
 * arithmetic and exactly wrong for storage here: Prisma hands a BigInt back on every read, and
 * order items are returned raw from a dozen endpoints, so JSON.stringify threw on all of them.
 * The counter-sale suite caught it on the first run.
 *
 * The sums are still done in whole paise by the pure engine. Only the resting place changed.
 */
export interface FrozenTax {
  hsnCode: string | null;
  taxRateBps: number | null;
  taxableValue: Prisma.Decimal | null;
  cgst: Prisma.Decimal | null;
  sgst: Prisma.Decimal | null;
  igst: Prisma.Decimal | null;
}

const NOTHING: FrozenTax = {
  hsnCode: null, taxRateBps: null, taxableValue: null, cgst: null, sgst: null, igst: null
};

export function freezeTaxForLine(
  standing: ProductTaxStanding,
  priced: PricedEnough,
  shopChargesTax: boolean,
  interState: boolean
): FrozenTax {
  // A composition or unregistered shop owes nothing, so there is nothing to freeze.
  if (!shopChargesTax) return NOTHING;
  if (!standing.hsnCode || standing.taxRateBps == null) return NOTHING;

  /*
   * A slabbed product priced INCLUSIVE of tax has no self-consistent rate between Rs 2,625 and
   * Rs 2,950 -- see PLAN-gst.md section 2. Rather than pick one and be wrong half the time, this
   * records nothing and lets buildBill refuse the document with an explanation a shopkeeper can
   * act on. A null here is honest; a guess is a wrong invoice.
   */
  if (standing.taxSlabbed && !standing.priceIsExclusive) return NOTHING;

  const rule: RateRule = {
    hsnCode: standing.hsnCode,
    slabbed: standing.taxSlabbed,
    baseRateBps: standing.taxRateBps
  };

  /*
   * The threshold is PER PIECE and on the DISCOUNTED value: three lehengas at Rs 2,000 each stay
   * at 5%, and an offer taking one from Rs 2,600 to Rs 2,400 takes it from 18% to 5% -- because
   * GST is on the transaction value, not the list price.
   */
  const perPieceTaxable = standing.priceIsExclusive
    ? priced.unitPriceMinor
    : taxableFromInclusive(priced.unitPriceMinor, standing.taxRateBps).taxableValueMinor;

  const rateBps = rateFor(rule, perPieceTaxable);

  const taxable = standing.priceIsExclusive
    ? priced.totalPriceMinor
    : taxableFromInclusive(priced.totalPriceMinor, rateBps).taxableValueMinor;

  const split = taxForLine({ taxableValueMinor: taxable, rateBps, interState });

  return {
    hsnCode: standing.hsnCode,
    taxRateBps: rateBps,
    taxableValue: fromMinor(taxable),
    cgst: fromMinor(split.cgstMinor),
    sgst: fromMinor(split.sgstMinor),
    igst: fromMinor(split.igstMinor)
  };
}
