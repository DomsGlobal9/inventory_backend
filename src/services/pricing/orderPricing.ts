/**
 * What one line of a sales order actually costs, and who decided.
 *
 * Inventory never originates a sales order. Every one of them arrives from somewhere that has
 * ALREADY quoted a price to a human being -- a till with a customer standing at it, a website
 * that showed a basket total, a Shopify checkout that has been paid. Until now this service
 * ignored that entirely: `createFullOrder` accepted `item.unitPrice`, dropped it, and re-priced
 * the line from our own catalogue.
 *
 * The consequence was not cosmetic. A saree sold online at ₹9,600 after a ₹2,400 discount was
 * recorded as a ₹12,000 sale, and `grossProfit` -- which is subtraction against cost -- was
 * overstated by the whole discount on every discounted order ever taken. So were the day book's
 * revenue figures, which multiply `unitPrice` by the dispatched quantity.
 *
 * This module is where that is decided now, in one place, with the decision recorded on the row
 * so it can be audited afterwards rather than inferred.
 */

import { badRequest } from '../../utils/httpError';
import { allocate, netUnitPrice, toMinor } from './money';

/**
 * Where a line's price came from. Stored on the row, because "trust the caller" is only safe if
 * afterwards you can say which lines were trusted and which we priced ourselves.
 *
 *   CATALOGUE  we resolved it from the variant and its location profile. The old behaviour,
 *              still correct for a line whose caller expressed no opinion.
 *   EXTERNAL   the selling system told us what was charged. Shopify, a marketplace, a POS that
 *              has already taken the money. Not second-guessed.
 *   QUOTE      our own pricing engine said so, and the order carries the quote id. Phase 3.
 *   MANUAL     a person overrode it at the till, with a reason. Phase 3.
 */
export type PriceSource = 'CATALOGUE' | 'EXTERNAL' | 'QUOTE' | 'MANUAL';

/** What a caller may say about one line's money. All optional; all of it is checked. */
export interface IncomingLinePrice {
  /** Net price per unit actually charged. */
  unitPrice?: number | null;
  /** Price per unit before any discount. */
  listUnitPrice?: number | null;
  /** Discount on this LINE in total -- not per unit. Mirrors Shopify's discount_allocations. */
  lineDiscount?: number | null;
}

export interface PricedLine {
  quantity: number;
  /** Gross per unit, in paise. */
  listUnitPriceMinor: number;
  /** This line's own discount, in paise. */
  lineDiscountMinor: number;
  /** Its share of an order-level discount, in paise. Filled in by `allocateOrderDiscount`. */
  allocatedDiscountMinor: number;
  /** Net line total, in paise. The authoritative number. */
  totalPriceMinor: number;
  /** Net per unit, in paise. Derived from the total; see money.netUnitPrice. */
  unitPriceMinor: number;
  priceSource: PriceSource;
}

/** True when the caller expressed any opinion at all about this line's money. */
export function callerSuppliedPrice(incoming: IncomingLinePrice | undefined): boolean {
  if (!incoming) return false;
  return incoming.unitPrice != null || incoming.listUnitPrice != null || incoming.lineDiscount != null;
}

/**
 * Price one line.
 *
 * `catalogueUnitPriceMinor` is what `resolveVariantForLocation` says this variant costs at this
 * location. It is used when the caller says nothing, and as a fallback for the gross price when
 * the caller gives only a discount.
 *
 * The interesting case is a caller who supplies a net price and nothing else. We record the
 * gross as EQUAL to it -- not as our catalogue price with the difference written up as a
 * discount. Inventing a discount nobody declared would put a number on a report that no
 * merchant ever agreed to, and the two prices differ for entirely innocent reasons: a Shopify
 * store that simply charges more than the shop floor does is not running a negative promotion.
 * A caller that means "this was discounted" says so, by sending the gross as well.
 */
export function priceLine(
  quantity: number,
  catalogueUnitPriceMinor: number,
  incoming: IncomingLinePrice | undefined,
  label: string
): PricedLine {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw badRequest(`Quantity for ${label} must be a whole number above zero.`);
  }

  if (!callerSuppliedPrice(incoming)) {
    const totalPriceMinor = catalogueUnitPriceMinor * quantity;
    return {
      quantity,
      listUnitPriceMinor: catalogueUnitPriceMinor,
      lineDiscountMinor: 0,
      allocatedDiscountMinor: 0,
      totalPriceMinor,
      unitPriceMinor: catalogueUnitPriceMinor,
      priceSource: 'CATALOGUE'
    };
  }

  const net = incoming!.unitPrice != null ? toMinor(incoming!.unitPrice) : null;
  const listUnitPriceMinor =
    incoming!.listUnitPrice != null ? toMinor(incoming!.listUnitPrice)
    : net != null ? net
    : catalogueUnitPriceMinor;

  let lineDiscountMinor: number;
  if (incoming!.lineDiscount != null) {
    lineDiscountMinor = toMinor(incoming!.lineDiscount);
  } else if (net != null) {
    // Gross was given explicitly alongside a net: the difference IS the discount.
    lineDiscountMinor = Math.max(0, listUnitPriceMinor * quantity - net * quantity);
  } else {
    lineDiscountMinor = 0;
  }

  if (listUnitPriceMinor < 0) throw badRequest(`Price for ${label} cannot be negative.`);
  if (lineDiscountMinor < 0) throw badRequest(`Discount for ${label} cannot be negative.`);

  const grossMinor = listUnitPriceMinor * quantity;
  if (lineDiscountMinor > grossMinor) {
    throw badRequest(
      `Discount on ${label} is larger than the line itself. ` +
      `A line cannot be sold for less than nothing.`
    );
  }

  const totalPriceMinor = grossMinor - lineDiscountMinor;

  // All three given, and they disagree. Refused rather than reconciled: picking one of two
  // contradictory numbers is how a customer is charged an amount nobody can later account for,
  // and the caller has a bug it needs to be told about.
  if (net != null && incoming!.listUnitPrice != null && incoming!.lineDiscount != null) {
    if (net * quantity !== totalPriceMinor) {
      throw badRequest(
        `The prices sent for ${label} do not add up: ` +
        `${quantity} x ${listUnitPriceMinor / 100} less ${lineDiscountMinor / 100} ` +
        `is ${totalPriceMinor / 100}, not ${(net * quantity) / 100}.`
      );
    }
  }

  return {
    quantity,
    listUnitPriceMinor,
    lineDiscountMinor,
    allocatedDiscountMinor: 0,
    totalPriceMinor,
    unitPriceMinor: netUnitPrice(totalPriceMinor, quantity),
    priceSource: 'EXTERNAL'
  };
}

/**
 * Spread an order-level discount across the lines it applies to.
 *
 * `SalesOrder.discountAmount` is a single figure typed against the whole order -- "₹500 off" --
 * and on its own it tells no line which part of it belongs to them. That is why `grossProfit`
 * was wrong even for orders that recorded their discount correctly: the subtraction happened at
 * the order total, and the per-line profit never saw it.
 *
 * Weighted by each line's total AFTER its own discount, so a line already marked down does not
 * absorb a second share proportional to a price nobody is paying.
 *
 * Mutates and returns the lines, so `allocatedDiscountMinor` and the recomputed totals travel
 * with them.
 */
export function allocateOrderDiscount(
  lines: PricedLine[],
  orderDiscountMinor: number,
  options: { clamp?: boolean } = {}
): PricedLine[] {
  if (lines.length === 0 || orderDiscountMinor <= 0) {
    for (const line of lines) line.allocatedDiscountMinor = 0;
    return lines;
  }

  const netTotals = lines.map(l => l.listUnitPriceMinor * l.quantity - l.lineDiscountMinor);
  const netSum = netTotals.reduce((a, b) => a + b, 0);

  /*
   * A discount bigger than the order it is on.
   *
   * Refused when a caller states it -- that is a bug in the till or the website, and an order
   * worth less than nothing is not something to accept quietly.
   *
   * Clamped when we are re-deriving an order that a person is editing. A merchant who put ₹500
   * off a ₹1,200 basket and then removes items down to ₹300 must not be told they cannot remove
   * the item; they would be stuck, unable to take the line out without first finding and
   * lowering a discount elsewhere on the screen. The discount shrinks to what is left, which is
   * visible on the order rather than silent.
   */
  let effective = orderDiscountMinor;
  if (effective > netSum) {
    if (!options.clamp) {
      throw badRequest(
        `The discount on this order (${orderDiscountMinor / 100}) is more than the order is worth ` +
        `(${netSum / 100}).`
      );
    }
    effective = netSum;
  }

  const shares = allocate(effective, netTotals);

  lines.forEach((line, index) => {
    line.allocatedDiscountMinor = shares[index];
    line.totalPriceMinor = netTotals[index] - shares[index];
    line.unitPriceMinor = netUnitPrice(line.totalPriceMinor, line.quantity);
  });

  return lines;
}

/**
 * The order's own three figures, derived from its lines and never from anything else.
 *
 * `subtotal` stays GROSS -- the sum of list prices before any discount -- because that is what
 * it has always meant here and what `total = subtotal - discount + tax + shipping` assumes. An
 * order whose caller sends nothing new therefore produces byte-identical totals to before this
 * change; only the per-line breakdown underneath it is new.
 */
export function orderTotalsFrom(lines: PricedLine[], taxMinor: number, shippingMinor: number) {
  const subtotalMinor = lines.reduce((sum, l) => sum + l.listUnitPriceMinor * l.quantity, 0);
  const discountMinor = lines.reduce((sum, l) => sum + l.lineDiscountMinor + l.allocatedDiscountMinor, 0);
  return {
    subtotalMinor,
    discountMinor,
    totalMinor: subtotalMinor - discountMinor + taxMinor + shippingMinor
  };
}
