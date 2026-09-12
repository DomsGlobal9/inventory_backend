/**
 * Shopify mapping: telling ScaleEzy which of a store's locations and products are which of ours.
 *
 * Its own module, beside shopify-orders rather than inside it, because it answers a different
 * question and runs at a different time. Orders are about what was sold; this is setup a merchant
 * does once and revisits when their store changes. Order ingestion READS what this writes.
 *
 *   adminApi            asking the store a question, behind an interface so the decisions below
 *                       can be tested without a live store
 *   locations.service   pairing a Shopify location with one of ours, one to one
 *   variants.service    adopting Shopify variants whose SKU is unmistakably one of ours. Read-only
 *                       towards Shopify: nothing is created or changed in the store.
 *
 * Importers take this folder, not the files inside it.
 */
export { adminApiFor, activeInstallation, numericShopifyId, ShopifyApiError } from './adminApi';
export type { ShopifyAdminApi } from './adminApi';

export { shopifyLocationPairingService, fetchShopifyLocations } from './locations.service';
export type { ShopifyLocation } from './locations.service';

export { shopifyVariantMatchingService, fetchShopifyVariants, planMatches, skuKey } from './variants.service';
export type { ShopifyVariant, OurVariant, ExistingMap } from './variants.service';
