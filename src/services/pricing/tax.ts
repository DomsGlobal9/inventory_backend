/**
 * What a line owes in GST.
 *
 * PURE. Everything it needs is handed to it: the taxable value already worked out, the rate already
 * chosen, and whether the customer is in another state. No database, no clock, no lookup. That is
 * deliberate and it is the same reason `priceBasket` is pure -- a till reprices on every keystroke
 * and cannot afford a round trip, a POS sold on its own has no Inventory to ask, and offline there
 * is nobody to ask at all.
 *
 * WHAT THIS FILE DOES NOT DO, ON PURPOSE:
 *
 *   - It does not decide the RATE. That comes from the product's HSN and, for stitched apparel,
 *     from the transaction value. `rateFor` below does that, and it is also pure, but it is a
 *     separate function because the two questions fail differently: a missing HSN is a setup
 *     mistake the shop must fix, and a wrong split is an arithmetic bug.
 *   - It does not read the product. A sale stores the rate it charged; it never asks again. The
 *     rates changed on 22 September 2025, so a bill reprinted from the week before must show the
 *     OLD rate -- the one the customer actually paid. Asking the product at reprint time would
 *     print a document that disagrees with the money taken.
 *   - It does not round the invoice total. That is one round-off line on the order, not something
 *     smeared across the tax.
 *
 * Everything is in paise, integers, like the rest of pricing.
 */

import { allocate } from './allocate';

/** 500 = 5%, 1800 = 18%, 0 = exempt. Basis points, so a half-percent rate is expressible. */
export type RateBps = number;

export interface TaxInput {
  /** After every discount, before tax. GST is on the transaction value. */
  taxableValueMinor: number;
  rateBps: RateBps;
  /** True when the place of supply is a different state from the shop's. */
  interState: boolean;
}

export interface TaxSplit {
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalTaxMinor: number;
}

export const NIL: TaxSplit = { cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalTaxMinor: 0 };

/**
 * The tax on one line.
 *
 * CGST and SGST are half each -- but half of an odd number of paise has to go somewhere, and it
 * must go to the same place every time or two runs of the same bill disagree. `allocate` already
 * settles that question for discounts; using it here means one rule in the codebase rather than
 * two, and the pair always adds back to the total exactly.
 */
export function taxForLine(input: TaxInput): TaxSplit {
  const { taxableValueMinor, rateBps, interState } = input;

  if (!Number.isInteger(taxableValueMinor)) {
    throw new Error('taxableValueMinor must be whole paise');
  }
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new Error('rateBps must be a whole number of basis points, zero or more');
  }

  // Exempt, or a zero-value line such as a free gift. Both still appear on the invoice.
  if (rateBps === 0 || taxableValueMinor === 0) return NIL;

  /*
   * Rounded to the nearest paisa, not floored. Flooring loses up to a paisa on every line, and on
   * a hundred-line bill that is a rupee the shop paid out of its own pocket. `Math.round` on a
   * negative (a credit note line) rounds towards positive infinity, so the sign is taken out
   * first and put back after -- otherwise a refund and the sale it reverses can differ by a paisa.
   */
  const sign = taxableValueMinor < 0 ? -1 : 1;
  const magnitude = Math.round((Math.abs(taxableValueMinor) * rateBps) / 10_000);
  const totalTaxMinor = sign * magnitude;

  if (interState) {
    return { cgstMinor: 0, sgstMinor: 0, igstMinor: totalTaxMinor, totalTaxMinor };
  }

  const [cgstMinor, sgstMinor] = allocate(totalTaxMinor, [1, 1]);
  return { cgstMinor, sgstMinor, igstMinor: 0, totalTaxMinor };
}

/**
 * The taxable value hidden inside a tax-inclusive price.
 *
 * The shop's shelf prices include GST -- the number on the tag is the number the customer pays.
 * The invoice still has to show what was tax and what was not, so it is worked backwards.
 *
 * Rounded, again, rather than floored, and the tax is then the REMAINDER rather than a second
 * rounded multiplication. Doing it the other way lets `taxable + tax` come to a paisa more or less
 * than the price on the tag, which is the one number the customer can check.
 */
export function taxableFromInclusive(inclusiveMinor: number, rateBps: RateBps): {
  taxableValueMinor: number;
  taxMinor: number;
} {
  if (!Number.isInteger(inclusiveMinor)) throw new Error('inclusiveMinor must be whole paise');
  if (rateBps === 0) return { taxableValueMinor: inclusiveMinor, taxMinor: 0 };

  const sign = inclusiveMinor < 0 ? -1 : 1;
  const gross = Math.abs(inclusiveMinor);
  const taxable = Math.round((gross * 10_000) / (10_000 + rateBps));
  return {
    taxableValueMinor: sign * taxable,
    taxMinor: sign * (gross - taxable)
  };
}

/** The other direction: what a tax-exclusive price becomes on the tag. */
export function inclusiveFromTaxable(taxableValueMinor: number, rateBps: RateBps): number {
  if (!Number.isInteger(taxableValueMinor)) throw new Error('taxableValueMinor must be whole paise');
  if (rateBps === 0) return taxableValueMinor;
  const sign = taxableValueMinor < 0 ? -1 : 1;
  const base = Math.abs(taxableValueMinor);
  return sign * (base + Math.round((base * rateBps) / 10_000));
}

/* ── Choosing the rate ──────────────────────────────────────────────────────────────────── */

/**
 * Whether this product's rate depends on what the piece sells for.
 *
 * A saree is FABRIC and is 5% at any price -- a ₹40,000 kanchipuram is still 5%. Stitched apparel
 * (a lehenga, a blouse, a readymade kurti) is 5% up to ₹2,500 a piece and 18% above it.
 *
 * The old ₹1,000 threshold and the 12% slab were removed on 22 September 2025. Anything still
 * quoting "5% under ₹1,000, 12% above" is working from rules that no longer exist.
 */
export interface RateRule {
  /** The shop's HSN for this product. Never guessed here. */
  hsnCode: string;
  /** True for stitched apparel, where the value decides. False for fabric. */
  slabbed: boolean;
  /** Used when `slabbed` is false, and as the low rate when it is true. */
  baseRateBps: RateBps;
  /** Only when `slabbed`. */
  thresholdMinor?: number;
  highRateBps?: RateBps;
}

/** The standard Indian rule as it stands on 27 September 2026. */
export const APPAREL_RULE = {
  slabbed: true,
  baseRateBps: 500,
  thresholdMinor: 250_000,   // ₹2,500 per piece, tax-exclusive
  highRateBps: 1800
} as const;

export const FABRIC_RULE = { slabbed: false, baseRateBps: 500 } as const;

/**
 * WHAT THE RATE WOULD BE under the slab rule -- used to ADVISE, not to decide.
 *
 * The rate charged is whatever the shop typed on the product. That is deliberate and it is what
 * the established products do: Tally and Marg both have the shopkeeper classify and the software
 * apply. It also dissolves a problem deriving the rate created -- a stitched piece priced
 * INCLUSIVE of tax between Rs 2,625 and Rs 2,950 had no self-consistent rate at all, because the
 * threshold is on the value excluding tax and the rate decides what that value is. Nothing to
 * derive, nothing to contradict.
 *
 * This is kept so there is still one place that knows the legal rule, and `slabWarning` below
 * uses it to notice when a shop's own figure looks wrong.
 *
 * The rate for one piece.
 *
 * `perPieceTaxableMinor` is the value of ONE piece after discount, not the line total. The
 * threshold is per piece: three lehengas at ₹2,000 each are 5%, not 18% because they add to
 * ₹6,000.
 *
 * And the value used is the DISCOUNTED one, because GST is on the transaction value -- so an offer
 * that takes a lehenga from ₹2,600 to ₹2,400 also takes it from 18% to 5%. That is correct, and it
 * is the sort of thing a shop notices on the bill and asks about.
 */
export function rateFor(rule: RateRule, perPieceTaxableMinor: number): RateBps {
  if (!rule.slabbed) return rule.baseRateBps;

  const threshold = rule.thresholdMinor ?? APPAREL_RULE.thresholdMinor;
  const high = rule.highRateBps ?? APPAREL_RULE.highRateBps;
  return Math.abs(perPieceTaxableMinor) > threshold ? high : rule.baseRateBps;
}

/**
 * "This looks under-taxed" -- one plain sentence, or nothing.
 *
 * A warning rather than a correction, on purpose. Changing a shop's rate behind its back is how
 * software ends up disagreeing with the shopkeeper's own accountant; refusing the sale over it
 * would stop a counter queue for something that may be perfectly deliberate. So the software
 * notices and says so, and the person decides -- the same bargain as suggestHsn, which proposes
 * an HSN and refuses to write it in.
 *
 * Only the DANGEROUS direction is flagged. Charging too much means the customer overpaid and the
 * shop owes it on anyway; charging too little means the shop owes the difference AND a penalty.
 * One warning about the case that costs money beats two a shopkeeper learns to ignore.
 */
export function slabWarning(
  label: string,
  rule: RateRule,
  perPieceTaxableMinor: number,
  rateCharged: RateBps
): string | null {
  if (!rule.slabbed) return null;
  const expected = rateFor({ ...rule, baseRateBps: rateCharged }, perPieceTaxableMinor);
  if (expected <= rateCharged) return null;

  const threshold = (rule.thresholdMinor ?? APPAREL_RULE.thresholdMinor) / 100;
  return `${label} is stitched clothing selling above Rs ${threshold.toLocaleString('en-IN')} a piece, ` +
    `where GST is usually ${expected / 100}%. It is set to ${rateCharged / 100}% -- please check that is right.`;
}

/* ── What the shop is allowed to issue ──────────────────────────────────────────────────── */

/**
 * Not every shop may charge GST, and this is worse to get wrong than a rate.
 *
 * A composition dealer that charges GST is collecting tax it has no right to collect. An
 * unregistered shop has no GSTIN to print. Both must issue a different document, and a Bill of
 * Supply has to SAY that the seller is not eligible to collect tax.
 *
 * A string union rather than a Prisma enum on purpose: adding a value to a shared database enum is
 * what took the alerts endpoint down on 23 September.
 */
export type GstRegistration = 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
export type DocumentKind = 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'RECEIPT';

export function mayChargeTax(registration: GstRegistration): boolean {
  return registration === 'REGULAR';
}

export function documentKindFor(registration: GstRegistration): DocumentKind {
  if (registration === 'REGULAR') return 'TAX_INVOICE';
  if (registration === 'COMPOSITION') return 'BILL_OF_SUPPLY';
  return 'RECEIPT';
}

/* ── Rounding the bill ──────────────────────────────────────────────────────────────────── */

/**
 * The invoice total goes to the nearest rupee, and the difference is its own line.
 *
 * Never achieved by adjusting the tax: the tax figures are what get reported, and bending one of
 * them to make a total look tidy is how a return stops reconciling. The round-off is a separate,
 * visible number -- which is also what a customer expects to see.
 */
export function roundOff(totalMinor: number): { roundedMinor: number; roundOffMinor: number } {
  const rounded = Math.round(totalMinor / 100) * 100;
  return { roundedMinor: rounded, roundOffMinor: rounded - totalMinor };
}
