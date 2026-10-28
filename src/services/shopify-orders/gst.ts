/**
 * The GST on a Shopify order, worked out by ScaleEzy -- never copied from Shopify.
 *
 * The owner's rule (26 Oct 2026): ScaleEzy is the one place that decides price and GST, on every
 * channel. Two engines make the returns wrong: Shopify once showed 18% on a saree from its own
 * settings while the shop had it at 5%. So Shopify products are pushed with tax switched off and
 * the final price in them, and an order's GST is worked out here, by the same rules as the till:
 *
 *   - the rate is what the shop typed on the product (variant first), via freezeTaxForLine;
 *   - Shopify's price is the FINAL price, so tax is taken out of it (inclusive), never added;
 *   - CGST + SGST inside the shop's state, IGST outside it, from the delivery address;
 *   - only a REGULAR shop with a GSTIN charges GST. Composition and unregistered shops record
 *     none -- GST is optional for every shop;
 *   - the delivery charge is a composite supply: taxed at the goods' rate (the highest rate on the
 *     order when the rates differ), included in the charge, and folded into that line's figures so
 *     the lines still add up to the bill.
 *
 * Shopify's own tax figures are a cross-check only. They decide money in one case: when Shopify
 * added tax ON TOP of the price (a product still taxable in Shopify, prices excluding tax), the
 * customer really paid it, so it is part of what the GST is carved out of -- and the shop is told,
 * because that product should not be taxable in Shopify.
 *
 * PURE: no database, no clock.
 */

import { freezeTaxForLine } from '../pricing/freezeTax';
import {
  taxableFromInclusive, taxForLine, slabWarning, mayChargeTax, documentKindFor,
  type GstRegistration, type DocumentKind
} from '../pricing/tax';
import { gstStateCodeOf } from '../pricing/gstState';
import { toMinor, netUnitPrice } from '../pricing';
import type { MappedOrder } from './mapping';

/** One line's product, as the tax rules need it. */
export interface LineStanding {
  /** For a sentence a shopkeeper can act on: the item code, or the title. */
  label: string;
  hsnCode: string | null;
  taxRateBps: number | null;
  taxSlabbed: boolean;
}

export interface ShopGst {
  /** Already through registrationInForce: no GSTIN means UNREGISTERED. */
  registration: GstRegistration;
  stateCode: string | null;
}

/** What gets frozen onto one sale line, in paise. Nulls when nothing was charged. */
export interface LineGst {
  hsnCode: string | null;
  taxRateBps: number | null;
  taxableMinor: number | null;
  cgstMinor: number | null;
  sgstMinor: number | null;
  igstMinor: number | null;
}

export interface OrderGst {
  documentKind: DocumentKind;
  chargesTax: boolean;
  /** Where the goods went, as GST's two-digit code. Null: the shop's own state. */
  placeOfSupplyStateCode: string | null;
  interState: boolean;
  /** One per mapped line, in the same order; the delivery charge's share is inside one of them. */
  lines: LineGst[];
  /** The delivery charge's part, already folded into lines[onLine]. Null when there is none. */
  delivery: { onLine: number; rateBps: number; taxableMinor: number; taxMinor: number } | null;
  /** All the GST on the order. Inside the total, never added to it. */
  taxMinor: number;
  /** Plain sentences worth a shopkeeper's look. None of them stops the order. */
  warnings: string[];
  /** Ours against Shopify's, for the log. */
  crossCheck: string | null;
}

const NONE: LineGst = { hsnCode: null, taxRateBps: null, taxableMinor: null, cgstMinor: null, sgstMinor: null, igstMinor: null };

const rupees = (minor: number) => `Rs ${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function gstForShopifyOrder(order: MappedOrder, standings: LineStanding[], shop: ShopGst): OrderGst {
  const chargesTax = mayChargeTax(shop.registration);
  const documentKind = documentKindFor(shop.registration);
  const warnings: string[] = [];

  const supply = gstStateCodeOf(order.deliveredTo);
  const placeOfSupplyStateCode = supply ?? shop.stateCode ?? null;
  const interState = Boolean(chargesTax && shop.stateCode && placeOfSupplyStateCode && placeOfSupplyStateCode !== shop.stateCode);

  if (chargesTax && order.deliveredTo && !supply) {
    warnings.push('The delivery state on this order could not be read, so its GST was worked out as within your own state. Please check the address.');
  }

  /*
   * What the customer actually paid for each line. Shopify's price is the final price; only when
   * Shopify added its own tax on top did the customer pay more than it.
   */
  const addedOnTop = !order.taxesIncluded;
  const paidFor = order.lines.map(l => l.totalPriceMinor + (addedOnTop ? l.shopifyTaxMinor : 0));
  const shopifyLineTax = order.lines.reduce((s, l) => s + l.shopifyTaxMinor, 0);
  const deliveryPaid = order.shippingMinor + (addedOnTop ? Math.max(0, order.taxMinor - shopifyLineTax) : 0);

  const lines: LineGst[] = order.lines.map((l, i) => {
    const st = standings[i];
    if (!chargesTax || !st) return { ...NONE };
    if (!st.hsnCode || st.taxRateBps == null) {
      warnings.push(`${st.label} has no HSN code or GST rate set, so no GST was worked out on it. Set them on the product.`);
      return { ...NONE };
    }
    const frozen = freezeTaxForLine(
      { hsnCode: st.hsnCode, taxRateBps: st.taxRateBps, taxSlabbed: st.taxSlabbed, priceIsExclusive: false },
      { quantity: l.quantity, unitPriceMinor: netUnitPrice(paidFor[i], l.quantity), totalPriceMinor: paidFor[i] },
      true,
      interState
    );

    // The slab rule ADVISES, as on the till: the shop's rate is charged, a likely under-charge is said.
    const perPiece = taxableFromInclusive(netUnitPrice(paidFor[i], l.quantity), st.taxRateBps).taxableValueMinor;
    const warn = slabWarning(st.label, { hsnCode: st.hsnCode, slabbed: st.taxSlabbed, baseRateBps: st.taxRateBps }, perPiece, st.taxRateBps);
    if (warn) warnings.push(warn);

    return {
      hsnCode: frozen.hsnCode,
      taxRateBps: frozen.taxRateBps,
      taxableMinor: frozen.taxableValue == null ? null : toMinor(frozen.taxableValue),
      cgstMinor: frozen.cgst == null ? null : toMinor(frozen.cgst),
      sgstMinor: frozen.sgst == null ? null : toMinor(frozen.sgst),
      igstMinor: frozen.igst == null ? null : toMinor(frozen.igst)
    };
  });

  /*
   * Delivery: a composite supply, so it takes the goods' rate -- the highest on the order when they
   * differ (first such line on a tie) -- and is carried by that line.
   */
  let delivery: OrderGst['delivery'] = null;
  if (chargesTax && deliveryPaid > 0) {
    let onLine = -1;
    lines.forEach((l, i) => {
      if (l.taxRateBps == null) return;
      if (onLine < 0 || l.taxRateBps > (lines[onLine].taxRateBps ?? -1)) onLine = i;
    });
    if (onLine >= 0) {
      const rateBps = lines[onLine].taxRateBps!;
      const taxable = taxableFromInclusive(deliveryPaid, rateBps).taxableValueMinor;
      const split = taxForLine({ taxableValueMinor: taxable, rateBps, interState });
      const host = lines[onLine];
      host.taxableMinor = (host.taxableMinor ?? 0) + taxable;
      host.cgstMinor = (host.cgstMinor ?? 0) + split.cgstMinor;
      host.sgstMinor = (host.sgstMinor ?? 0) + split.sgstMinor;
      host.igstMinor = (host.igstMinor ?? 0) + split.igstMinor;
      delivery = { onLine, rateBps, taxableMinor: taxable, taxMinor: split.totalTaxMinor };
    }
  }

  const taxMinor = lines.reduce((s, l) => s + (l.cgstMinor ?? 0) + (l.sgstMinor ?? 0) + (l.igstMinor ?? 0), 0);

  if (addedOnTop && order.taxMinor > 0) {
    warnings.push(
      `Shopify added its own tax of ${rupees(order.taxMinor)} on top of the price on this order. ` +
      `ScaleEzy works out GST itself, so switch off "Charge tax" for these products in Shopify.`
    );
  }

  const crossCheck = order.taxMinor !== taxMinor
    ? `Shopify reported tax ${rupees(order.taxMinor)}; ScaleEzy worked out GST ${rupees(taxMinor)}.`
    : null;

  return { documentKind, chargesTax, placeOfSupplyStateCode, interState, lines, delivery, taxMinor, warnings, crossCheck };
}
