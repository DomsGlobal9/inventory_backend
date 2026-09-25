/**
 * Every shop's own online shop at `shop.scaleezy.com/<slug>` (PLAN-online-shop.md). Its own module:
 * nothing else in the backend reads or writes the `online_shops` tables, and this module reads
 * products only through the storefront catalogue service, never the product tables directly.
 */
export * as onlineShop from './shop.service';
export * as shopBanners from './banners';
export * as shopCheckout from './checkout';
/** What a shop and a customer are told when an order lands or stops. */
export * as onlineShopNotices from './notices';
export { facetsFor, forgetFacets } from './facets';
export * as shopOtp from './otp';
/** Addresses a shopper has saved, read only with the secret their browser earned by proving a number. */
export * as shopAddresses from './addresses';
export * as shopTryOn from './tryon';
/** Who is waiting for a piece that was sold out when they wanted it. */
export * as shopInterest from './interest';
export { OnlineShopRuleError } from './rules';
export { checkSlug, RESERVED_SLUGS } from './rules';
