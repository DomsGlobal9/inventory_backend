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
export * as shopTryOn from './tryon';
export { OnlineShopRuleError } from './rules';
export { checkSlug, RESERVED_SLUGS } from './rules';
