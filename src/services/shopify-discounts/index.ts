/**
 * Shopify discounts: an offer written here, copied into a connected Shopify store, and kept true.
 *
 * Its own module beside offers and shopify-orders. Offers own what a rule IS; shopify-orders owns
 * what was SOLD; this owns the copy of a rule in somebody else's checkout, which changes for its own
 * reasons -- a merchant edits it in Shopify, Shopify throttles us, a scope is revoked.
 *
 *   translate        an offer said in Shopify's words, or the plain reason it cannot be. Pure.
 *   mirror.service   pushing, reading back, drift, and the merchant's "push ours" / "accept theirs"
 *   dirty            an offer changed; queue its copies. Separate to keep imports acyclic.
 *   worker           the in-process timer that does the queued work
 *
 * Importers take this folder, not the files inside it.
 */
export { translateOffer, canonicalFromShopify, hashCanonical, describeDifferences, mirrorTag, isoSeconds } from './translate';
export type { MirrorableOffer, TranslationContext, CanonicalDiscount, Translation } from './translate';

export { offerMirrorService, refusalMessage, discountGidFromWebhook, QUERIES, RECONCILE_EVERY_MS } from './mirror.service';
export type { MirrorStatus, ApiFor } from './mirror.service';

export { markOfferMirrorsDirty } from './dirty';
export { OfferMirrorWorker } from './worker';
