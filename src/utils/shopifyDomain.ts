/**
 * Deciding whether a string really is a Shopify shop.
 *
 * This is the first line of the OAuth flow and the smallest file in it, and it is the one that
 * decides whether the rest is safe. Every step downstream builds a URL out of this value:
 *
 *     https://{shop}/admin/oauth/access_token        we send our client_secret here
 *     https://{shop}/admin/api/{version}/graphql.json   we send the merchant's token here
 *
 * So an unvalidated `shop` parameter is a request to post our own credentials to an attacker's
 * server. `shop` arrives in a query string that anyone can craft.
 *
 * The rule that matters is the ANCHOR at the end. Shopify's own documentation calls this out:
 * without the trailing `$`, a value such as
 *
 *     exampleshop.myshopify.com.attacker.example
 *
 * contains ".myshopify.com" and passes a naive check, while resolving to a host the attacker
 * owns. Both ends are anchored here for that reason, and the check is a whole-string match
 * rather than a search.
 */

/**
 * Anchored at both ends, deliberately.
 *
 *   - starts with a letter or digit (a leading hyphen is not a valid hostname label)
 *   - letters, digits and hyphens after that
 *   - then exactly ".myshopify.com", and then the string ENDS
 *
 * Case is normalised before matching rather than allowed in the pattern, so the stored domain
 * is canonical and two spellings of one shop cannot become two installations.
 */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The longest a hostname label may be. A 300-character "shop" is not a shop. */
const MAX_LENGTH = 255;

/**
 * Returns the canonical shop domain, or null if the value is not one.
 *
 * Null rather than a thrown error because every caller has to handle the invalid case anyway,
 * and a route that forgets a try/catch would otherwise 500 on input that is simply wrong.
 */
export function normaliseShopDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_LENGTH) return null;

  // A merchant typing their shop address is as likely to paste a URL as a bare hostname, and
  // "https://my-shop.myshopify.com/admin" should not be rejected as gibberish. Strip the parts
  // that are not the host, then validate what is left -- the validation still decides.
  const withoutScheme = trimmed.replace(/^https?:\/\//, '');
  const host = withoutScheme.split('/')[0].split('?')[0].split('#')[0];

  // Credentials or a port in the authority section mean this is not a plain shop domain, and
  // silently discarding them would validate something different from what was supplied.
  if (host.includes('@') || host.includes(':')) return null;

  return SHOP_DOMAIN.test(host) ? host : null;
}

/** True when the value is a shop domain we are willing to build a request URL from. */
export function isShopDomain(value: unknown): boolean {
  return normaliseShopDomain(value) !== null;
}

/**
 * The base of every Admin API URL for a shop.
 *
 * Takes an already-validated domain and refuses anything else, so there is no path from an
 * unchecked string to an outbound request even if a caller forgets to validate first.
 */
export function adminApiBase(shopDomain: string, apiVersion: string): string {
  const shop = normaliseShopDomain(shopDomain);
  if (!shop) throw new Error(`Refusing to build a Shopify URL from ${JSON.stringify(shopDomain)}`);
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) {
    throw new Error(`Refusing to build a Shopify URL with API version ${JSON.stringify(apiVersion)}`);
  }
  return `https://${shop}/admin/api/${apiVersion}`;
}
