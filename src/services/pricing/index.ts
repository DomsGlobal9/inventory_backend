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
 *   engine         what a whole basket costs once the shop's offers are applied to it. Pure:
 *                  the till and a merchant's own website both ask it and get the same answer,
 *                  which is the entire point -- their developer never sees the rules, so they
 *                  cannot implement them slightly differently.
 *   quote.service  loading the world for the engine -- the shop's live offers, the variants, the
 *                  prices at this location -- and then FREEZING the answer, so a basket priced at
 *                  23:59:58 is not charged differently at 00:00:03.
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

export { priceBasket } from './engine';
export type {
  BasketLine, CandidateOffer, AppliedOffer, PricedBasketLine, PricedBasket
} from './engine';

export { pricingQuoteService, fingerprint, pricedLinesFromQuote, QUOTE_TTL_MS } from './quote.service';
export type { QuoteRequest } from './quote.service';

export { normaliseManualDiscount, requestsManualDiscount, REASON_MIN_LENGTH, REASON_MAX_LENGTH } from './manualDiscount';
export type { ManualDiscount, ManualDiscountInput } from './manualDiscount';
