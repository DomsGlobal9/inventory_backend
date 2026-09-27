/**
 * Priced lines in, a finished bill out.
 *
 * This is the piece the till, the online shop and the invoice all need and none of them should
 * write for themselves. It takes lines that have already been priced and discounted -- that is
 * `priceBasket`'s job, not this one -- and works out what tax is owed, which document the shop is
 * allowed to issue, and what the customer actually pays.
 *
 * PURE, for the third time in this folder and for the same three reasons: a till reprices on every
 * keystroke and cannot afford a round trip, a POS sold standalone has no Inventory to ask, and
 * offline there is nobody to ask at all.
 *
 * IT REFUSES RATHER THAN GUESSES. A product with no HSN, or a slabbed product priced inclusive of
 * tax, comes back in `problems` and the bill is marked not issuable. Nothing here quietly falls
 * back to zero tax -- a zero-tax invoice from a registered shop is not a lesser invoice, it is a
 * wrong one, and it is wrong four hundred times before anybody notices.
 */

import {
  taxForLine, taxableFromInclusive, rateFor, roundOff,
  mayChargeTax, documentKindFor,
  type GstRegistration, type DocumentKind, type RateBps, type RateRule
} from './tax';

export interface BillLineInput {
  /** For messages a shopkeeper has to act on. */
  label: string;
  quantity: number;
  /** After discount. Inclusive or exclusive of tax according to `priceIsExclusive`. */
  netUnitPriceMinor: number;
  /** After discount, for the whole line. */
  lineTotalMinor: number;

  hsnCode: string | null;
  taxRateBps: RateBps | null;
  /** True for stitched apparel, where the rate depends on what ONE piece sells for. */
  taxSlabbed: boolean;
  /** True when the stored price excludes tax. Fabric stays inclusive; see PLAN-gst.md section 2. */
  priceIsExclusive: boolean;
}

export interface BillLine extends BillLineInput {
  /** What gets frozen onto the sale line. */
  rateBpsCharged: RateBps;
  taxableValueMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  /** taxable + tax. Equals lineTotalMinor when the price was inclusive. */
  lineGrossMinor: number;
}

export interface Bill {
  documentKind: DocumentKind;
  interState: boolean;
  chargesTax: boolean;
  lines: BillLine[];
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalTaxMinor: number;
  /** Before rounding. */
  grossMinor: number;
  roundOffMinor: number;
  /** What the customer pays. */
  payableMinor: number;
  /** Plain sentences a shopkeeper can act on. Empty means the bill may be issued. */
  problems: string[];
  /** False when `problems` is non-empty and the shop is one that must charge tax. */
  issuable: boolean;
}

export interface BillInput {
  registration: GstRegistration;
  /** Two digits. Null for a shop that has not set it. */
  shopStateCode: string | null;
  /** Two digits. Null means "same as the shop" -- which is every counter sale. */
  placeOfSupplyStateCode?: string | null;
  lines: BillLineInput[];
}

export function buildBill(input: BillInput): Bill {
  const { registration, shopStateCode, placeOfSupplyStateCode, lines } = input;
  const problems: string[] = [];

  const chargesTax = mayChargeTax(registration);
  const documentKind = documentKindFor(registration);

  /*
   * A counter sale has no place of supply of its own: the customer is standing in the shop, so it
   * is the shop's state. Null therefore means "here", not "unknown" -- treating it as unknown
   * would make every till sale inter-state and put IGST on a bill handed across a counter.
   */
  const supplyState = placeOfSupplyStateCode ?? shopStateCode;
  const interState = Boolean(shopStateCode && supplyState && supplyState !== shopStateCode);

  if (chargesTax && !shopStateCode) {
    problems.push('This shop has no GST state code set, so the bill cannot say whether it is CGST and SGST or IGST.');
  }

  const out: BillLine[] = [];
  let taxableMinor = 0, cgstMinor = 0, sgstMinor = 0, igstMinor = 0, grossMinor = 0;

  for (const line of lines) {
    // A shop that may not charge tax bills the money and nothing else. Its document says why.
    if (!chargesTax) {
      out.push({
        ...line, rateBpsCharged: 0, taxableValueMinor: line.lineTotalMinor,
        cgstMinor: 0, sgstMinor: 0, igstMinor: 0, lineGrossMinor: line.lineTotalMinor
      });
      taxableMinor += line.lineTotalMinor;
      grossMinor += line.lineTotalMinor;
      continue;
    }

    if (!line.hsnCode || line.taxRateBps == null) {
      problems.push(`${line.label} has no HSN code or tax rate set. Set it on the product before billing it.`);
    }

    /*
     * The section 2 contradiction, refused at source rather than resolved by guesswork.
     *
     * A slabbed product priced INCLUSIVE of tax has no self-consistent rate between ₹2,625 and
     * ₹2,950: at 5% the taxable value lands above the ₹2,500 threshold, and at 18% it lands below
     * it. There is no arithmetic answer, so the setup is wrong rather than the sum. Saying so here
     * is the whole reason `priceIsExclusive` exists.
     */
    if (line.taxSlabbed && !line.priceIsExclusive) {
      problems.push(`${line.label} is stitched clothing, so its price must be entered without tax. Its rate depends on the price, and a price that already includes tax cannot decide its own rate.`);
    }

    const baseRule: RateRule = {
      hsnCode: line.hsnCode ?? '',
      slabbed: line.taxSlabbed,
      baseRateBps: line.taxRateBps ?? 0
    };

    /*
     * The threshold is PER PIECE and on the DISCOUNTED value -- three lehengas at ₹2,000 each are
     * 5%, not 18% because they add to ₹6,000; and an offer taking one from ₹2,600 to ₹2,400 takes
     * it from 18% to 5%, because GST is on the transaction value.
     */
    const perPieceTaxable = line.priceIsExclusive
      ? line.netUnitPriceMinor
      : taxableFromInclusive(line.netUnitPriceMinor, line.taxRateBps ?? 0).taxableValueMinor;

    const rateBpsCharged = line.taxRateBps == null ? 0 : rateFor(baseRule, perPieceTaxable);

    const taxable = line.priceIsExclusive
      ? line.lineTotalMinor
      : taxableFromInclusive(line.lineTotalMinor, rateBpsCharged).taxableValueMinor;

    const split = taxForLine({ taxableValueMinor: taxable, rateBps: rateBpsCharged, interState });
    const lineGross = taxable + split.totalTaxMinor;

    out.push({
      ...line, rateBpsCharged, taxableValueMinor: taxable,
      cgstMinor: split.cgstMinor, sgstMinor: split.sgstMinor, igstMinor: split.igstMinor,
      lineGrossMinor: lineGross
    });

    taxableMinor += taxable;
    cgstMinor += split.cgstMinor;
    sgstMinor += split.sgstMinor;
    igstMinor += split.igstMinor;
    grossMinor += lineGross;
  }

  const { roundedMinor, roundOffMinor } = roundOff(grossMinor);

  return {
    documentKind, interState, chargesTax, lines: out,
    taxableMinor, cgstMinor, sgstMinor, igstMinor,
    totalTaxMinor: cgstMinor + sgstMinor + igstMinor,
    grossMinor, roundOffMinor, payableMinor: roundedMinor,
    problems,
    issuable: problems.length === 0
  };
}

/**
 * The financial year an invoice number belongs to, Indian style: April to March.
 *
 * "2026-27" for anything from 1 April 2026 to 31 March 2027. The series restarts each year, which
 * is why this is part of the invoice's identity and not just a date on it.
 */
export function financialYearOf(when: Date): string {
  const y = when.getFullYear();
  const startYear = when.getMonth() >= 3 ? y : y - 1;   // getMonth() is 0-based; 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
