/**
 * A Shopify webhook body with the person taken out of it.
 *
 * The order inbox keeps bodies verbatim so a parked order can be replayed from what Shopify
 * actually sent. That is the right call for the ORDER -- lines, prices, discounts, the location --
 * and the wrong one for the customer inside it once they have asked to be erased. So the keys that
 * describe a person go, and everything replay reads survives: an order replayed after this lands
 * on the shop's "Online guest", which is exactly what a customer with no identity is.
 *
 * Pure: no database, no clock. Returns a copy; the input is not touched.
 */

/**
 * Keys removed wherever they appear, at any depth.
 *
 * By name rather than by path because Shopify repeats the same personal blocks in several places
 * (the order, each fulfilment's destination, a refund's order adjustments), and a path list would
 * miss the next place they add one.
 */
export const PERSONAL_KEYS: ReadonlySet<string> = new Set([
  'customer',            // name, email, phone, default_address, notes, tags
  'email',
  'contact_email',
  'phone',
  'billing_address',
  'shipping_address',
  'destination',         // a fulfilment's delivery address
  'client_details',      // browser IP and user agent
  'browser_ip',
  'note',                // free text the customer typed at checkout
  'note_attributes',
  'order_status_url',    // a link that opens the customer's order page
  'token',
  'cart_token',
  'checkout_token',
  'landing_site',        // URLs can carry an email in a query string
  'referring_site',
  'landing_site_ref',
  'customer_locale'
]);

export function scrubShopifyPayload<T = unknown>(payload: T): T {
  return strip(payload) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (PERSONAL_KEYS.has(key)) continue;
    out[key] = strip(inner);
  }
  return out;
}

/**
 * The personal parts of a stored body, for a data request.
 *
 * What we hold about a person inside a parked message, and nothing else -- the merchant already has
 * the order itself in Shopify.
 */
export function personalPartsOf(payload: any): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const parts: Record<string, unknown> = {};
  for (const key of ['customer', 'email', 'contact_email', 'phone', 'billing_address', 'shipping_address', 'note']) {
    if (payload[key] !== undefined && payload[key] !== null) parts[key] = payload[key];
  }
  return parts;
}
