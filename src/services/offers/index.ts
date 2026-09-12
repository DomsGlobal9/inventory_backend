/**
 * Offers: one place a merchant writes a discount, whichever storefront it sells through.
 *
 * Its own module, like services/tryon and services/shopify-orders, because it will grow in a
 * direction of its own -- a pricing engine, a mirror into Shopify, a report on what each offer
 * actually saved -- and none of that belongs inside the service that happens to write order rows.
 *
 * Two files, split by what can be tested without a database:
 *
 *   rules          what makes an offer valid, what it is worth, and which of two competing
 *                  offers wins a line. Pure, so every refusal can be checked against a shape
 *                  before a tenant exists.
 *   offer.service  writing, changing and retiring one -- and above all never rewriting its
 *                  history, so an order placed in October still explains itself in March.
 *
 *   redemption     spending an offer's allowance and giving it back, inside the transaction
 *                  that writes the order -- because checking a limit and spending it have to be
 *                  one indivisible step or "first 50 customers" serves fifty-one.
 *
 * Nothing here APPLIES an offer to a basket. That is Phase 3, and it reads this module.
 *
 * Importers take this folder, not the files inside it.
 */
export {
  validateOffer,
  effectiveStatus,
  isLive,
  discountFor,
  compareCandidates
} from './rules';
export type { OfferDraft, OfferStatusName } from './rules';

export { offerService } from './offer.service';
export type { OfferInput } from './offer.service';

export { offerRedemptionService } from './redemption.service';
export type { RedemptionRequest, RedemptionContext } from './redemption.service';
