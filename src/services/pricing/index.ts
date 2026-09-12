/**
 * Pricing: what a thing costs, and who decided.
 *
 * Its own module rather than a few helpers inside sales-order.service, because pricing is about
 * to grow a great deal -- offers, a basket-quoting endpoint the till and the website both call,
 * and a mirror of the rules into Shopify -- and none of that belongs inside the service that
 * happens to write order rows today.
 *
 * Two files so far, split by what they are responsible for rather than by size:
 *
 *   money          integers, rounding and allocation. Knows nothing about orders.
 *   orderPricing   one line of an order: whose price wins, and how an order-level discount is
 *                  divided between lines.
 *
 * Importers take this folder, not the files inside it, so the split above can change without
 * every caller changing with it.
 */
export { toMinor, fromMinor, minorToNumber, applyPercent, allocate, netUnitPrice, portionOf } from './money';
export type { MoneyLike } from './money';

export {
  priceLine,
  allocateOrderDiscount,
  orderTotalsFrom,
  callerSuppliedPrice
} from './orderPricing';
export type { PriceSource, IncomingLinePrice, PricedLine } from './orderPricing';
