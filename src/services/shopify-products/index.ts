/**
 * Shopify products: our products made, kept true and archived in a connected Shopify store.
 *
 * Its own module beside shopify-mapping (which only READS the store to match what is already there)
 * and shopify-discounts (offers). This one WRITES the shop's catalogue, which is why its rules are
 * strict: only products the shop switched on, archive and never delete, and a product the shop built
 * by hand in Shopify gets only its price and stock from here.
 *
 *   render        a product said in Shopify's words, or the plain reason it cannot be. Pure.
 *   push.service  the switch, the pushes, stock, and what Shopify's webhooks tell us
 *   dirty         a product or its stock changed; queue its copy. Separate to keep imports acyclic.
 *   worker        the in-process timer that does the queued work
 *
 * Importers take this folder, not the files inside it.
 */
export { renderProduct, canonicalFromWebhook, hashCanonical, describeEdits, descriptionHtml, wordsOf, scaleezyTag } from './render';
export type { Rendered, Canonical } from './render';

export { shopifyProductPushService, SHOPIFY_NOTICE } from './push.service';
export type { ApiFor } from './push.service';

export { markProductForShopify, markStockForShopify } from './dirty';
export { ShopifyProductWorker } from './worker';
