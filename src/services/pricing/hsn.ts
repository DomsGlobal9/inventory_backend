/**
 * A first guess at a product's HSN code and rate -- to be confirmed by the shop, never applied
 * silently.
 *
 * WHY A SUGGESTION AND NOT A DECISION. HSN is the shop's legal declaration about what it is
 * selling, and it is the shop that answers for it. Two products with the same `dressType` can
 * genuinely differ: an unstitched saree is FABRIC at a flat 5%, while a stitched saree-style gown
 * is APPAREL and crosses to 18% above Rs 2,500 a piece. Nothing in this system can tell those
 * apart from the words a shop typed into a free-text field.
 *
 * So this exists to save a shopkeeper typing 5007 four hundred times, not to decide anything. Every
 * suggestion carries `needsConfirming`, and the product's own column stays null until a human says
 * yes -- which is what stops a wrong code being printed on four hundred invoices at once.
 *
 * PURE, like the rest of pricing. Rates are as they stand after 22 September 2025, when the old
 * Rs 1,000 threshold and the 12% slab were removed.
 */

import { APPAREL_RULE, FABRIC_RULE, type RateBps } from './tax';

export interface HsnSuggestion {
  hsnCode: string;
  taxRateBps: RateBps;
  /** True for stitched apparel, where the rate depends on what one piece sells for. */
  taxSlabbed: boolean;
  /** Plain words for the shopkeeper, saying what was assumed. */
  because: string;
  /** Always true. Kept explicit so no caller can quietly treat this as settled. */
  needsConfirming: true;
  /**
   * Set when the product's own title contradicts its fabric field -- "kanchipuram saree" recorded
   * as Chiffon, which is a real row in a real shop. The suggestion still follows the FABRIC field,
   * because that is the one somebody chose deliberately from a list; but a shopkeeper reading
   * "silk, going in as man-made" will spot in a second what no rule here can decide.
   */
  conflict?: string;
}

/** Fabric: flat 5%, whatever the piece costs. The HSN differs only by what it is woven from. */
const FABRIC_BY_MATERIAL: ReadonlyArray<[RegExp, string, string]> = [
  [/silk|pattu|kanchi|banarasi|tussar|mulberry/i, '5007', 'silk fabric'],
  [/cotton|khadi|handloom|mangalgiri|linen/i, '5208', 'cotton fabric'],
  [/georgette|chiffon|crepe|satin|art ?silk|poly|synthetic|viscose|rayon/i, '5407', 'man-made fabric']
];

/** Stitched articles. Slabbed: 5% up to Rs 2,500 a piece, 18% above. */
const STITCHED: ReadonlyArray<[RegExp, string, string]> = [
  [/lehenga|ghagra|chaniya/i, '6204', 'a stitched lehenga'],
  [/blouse/i, '6206', 'a stitched blouse'],
  [/kurti|kurta|tunic/i, '6206', 'a stitched kurti'],
  [/gown|frock|dress/i, '6204', 'a stitched gown'],
  [/salwar|churidar|palazzo|pant|legging/i, '6204', 'stitched lower wear'],
  [/dupatta|stole|shawl|scarf/i, '6214', 'a made-up dupatta or stole']
];

const first = <T>(rows: ReadonlyArray<[RegExp, ...T[]]>, hay: string) =>
  rows.find(([re]) => re.test(hay));

/**
 * Suggest an HSN and rate from what the shop already typed.
 *
 * `dressType` is a free-text field ("Saree", "Lehenga"), and `fabric` is another ("Cotton",
 * "Silk"). Both are looked at, because a saree's HSN depends on the material and a lehenga's does
 * not depend on it at all.
 *
 * Returns null when nothing can be said honestly. A null here is the correct answer far more often
 * than a wrong code would be: the shop is then asked, which is what should happen anyway.
 */
export function suggestHsn(input: {
  dressType?: string | null;
  fabric?: string | null;
  productType?: string | null;
  /** Read only to spot a contradiction with `fabric`. It never changes the code chosen. */
  title?: string | null;
}): HsnSuggestion | null {
  const dress = (input.dressType ?? '').trim();
  const fabric = (input.fabric ?? '').trim();
  const title = (input.title ?? '').trim();
  if (!dress && !fabric) return null;

  /*
   * Does the title disagree with the fabric field?
   *
   * Titles are free text and often useless ("fsa", "saree34"), so they are never trusted to CHOOSE
   * a code. But when a title clearly names a material and the fabric field names a different one,
   * that is worth saying out loud -- one of the two is wrong, and only the shop knows which.
   */
  const materialOf = (text: string) => FABRIC_BY_MATERIAL.find(([re]) => re.test(text))?.[2] ?? null;
  const fromTitle = title ? materialOf(title) : null;
  const fromFabric = fabric ? materialOf(fabric) : null;
  const conflict = fromTitle && fromFabric && fromTitle !== fromFabric
    ? `The title reads like ${fromTitle} but the fabric is recorded as "${fabric}" (${fromFabric}). Going with the fabric field -- check which is right.`
    : undefined;

  /*
   * Stitched is checked FIRST and against the dress type only.
   *
   * "Silk Lehenga" contains both "silk" and "lehenga". Reading the material first would call it
   * fabric at a flat 5%, and a Rs 30,000 silk lehenga would be taxed at 5% when it owes 18% --
   * Rs 3,900 of tax on one piece, in the shop's favour, which is the direction that gets a shop
   * fined. What a thing IS decides its chapter; what it is made of only refines the code inside
   * that chapter.
   */
  const stitched = first(STITCHED, dress);
  if (stitched) {
    const [, code, words] = stitched;
    return {
      hsnCode: code,
      taxRateBps: APPAREL_RULE.baseRateBps,
      taxSlabbed: true,
      because: `Read as ${words}. Stitched clothing is 5% up to Rs 2,500 a piece and 18% above.`,
      needsConfirming: true,
      conflict
    };
  }

  // Fabric. A saree is the common case and is never slabbed, at any price.
  const looksLikeFabric = /saree|sari|fabric|material|cloth|yard|dhoti|towel|bedsheet/i.test(dress);
  if (looksLikeFabric || (!dress && fabric)) {
    const byMaterial = first(FABRIC_BY_MATERIAL, `${fabric} ${dress}`);
    const [, code, words] = byMaterial ?? [, '5208', 'fabric, assumed cotton'];
    return {
      hsnCode: code,
      taxRateBps: FABRIC_RULE.baseRateBps,
      taxSlabbed: false,
      because: `Read as ${words}. Fabric is 5% whatever it costs -- there is no price threshold.`,
      needsConfirming: true,
      conflict
    };
  }

  return null;
}

/**
 * Which HSN and rate actually apply to a variant, honouring the override.
 *
 * A variant's own code wins where it has one -- a saree sold with a stitched blouse is two
 * different things on one invoice. Returns nulls when the shop has not finished setting up, which
 * is what a registered shop's sale is refused on rather than defaulting to zero tax.
 */
export function effectiveTaxFor(
  product: { hsnCode?: string | null; taxRateBps?: number | null; taxSlabbed?: boolean | null },
  variant?: { hsnCode?: string | null; taxRateBps?: number | null } | null
): { hsnCode: string | null; taxRateBps: RateBps | null; taxSlabbed: boolean } {
  const hsnCode = variant?.hsnCode ?? product.hsnCode ?? null;
  const taxRateBps = variant?.taxRateBps ?? product.taxRateBps ?? null;
  return { hsnCode, taxRateBps, taxSlabbed: Boolean(product.taxSlabbed) };
}

/** 4 digits up to Rs 5 crore of turnover, 6 above. Printed, not stored differently. */
export function hsnForInvoice(hsnCode: string, turnoverAboveFiveCrore: boolean): string {
  const digits = hsnCode.replace(/\D/g, '');
  const want = turnoverAboveFiveCrore ? 6 : 4;
  return digits.length <= want ? digits : digits.slice(0, want);
}
