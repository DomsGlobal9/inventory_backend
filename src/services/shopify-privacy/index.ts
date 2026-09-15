/**
 * Shopify privacy: the three requests Shopify sends on behalf of customers and stores.
 *
 * Its own module, beside shopify-orders rather than inside it, because it answers a different
 * question -- not "what did this store sell" but "what do we hold about this person, and make it
 * go" -- and because it reaches across customers, orders and the inbox, which none of the order
 * services should need to know about each other.
 *
 *   scrub            a webhook body with the person taken out. Pure.
 *   privacy.service  recording each request, answering data requests, erasing customers and stores.
 *
 * Importers take this folder, not the files inside it.
 */
export { scrubShopifyPayload, personalPartsOf, PERSONAL_KEYS } from './scrub';
export { shopifyPrivacyService, isPrivacyTopic, PRIVACY_TOPICS, ERASED_NAME } from './privacy.service';
export type { PrivacyTopic } from './privacy.service';
