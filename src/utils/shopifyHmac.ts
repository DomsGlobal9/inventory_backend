import crypto from 'crypto';

/**
 * The two different HMACs Shopify uses, which are computed differently and are easy to confuse.
 *
 *   OAUTH CALLBACK    hex, over the sorted query string with `hmac` removed
 *   WEBHOOK           base64, over the RAW REQUEST BODY, exactly as received
 *
 * Getting either wrong fails in the same silent way -- every request is rejected and it reads
 * like a wrong secret -- so both live here, next to each other, with the difference stated.
 *
 * Both comparisons are constant time. A plain `===` on a signature leaks, through timing, how
 * many leading bytes matched, which over enough attempts recovers the signature a byte at a
 * time. `timingSafeEqual` throws on a length mismatch, so length is checked first.
 */

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verifies the `hmac` on an OAuth callback query string.
 *
 * Shopify signs the query parameters, not the body: remove `hmac`, sort what remains by key,
 * join as `key=value&key=value`, and HMAC-SHA256 it with the app's client secret. The result
 * is hex.
 *
 * `signature` is a legacy parameter that is also excluded when present; leaving it in produces
 * a mismatch on the small number of requests that still carry it.
 *
 * Note what this does and does not prove. It proves the query string came from Shopify and was
 * not altered. It does NOT prove the request is one WE started -- that is the `state` nonce's
 * job, and both checks are required.
 */
export function verifyOAuthCallback(
  query: Record<string, unknown>,
  clientSecret: string
): boolean {
  const provided = query.hmac;
  if (typeof provided !== 'string' || !provided) return false;

  const message = Object.keys(query)
    .filter(key => key !== 'hmac' && key !== 'signature')
    .sort()
    .map(key => {
      const value = query[key];
      // Repeated parameters arrive as an array. Joining with a comma is how Shopify's own
      // implementations serialise them; a bare String(array) would happen to produce the same
      // thing, but relying on that is an accident waiting to change.
      const flat = Array.isArray(value) ? value.join(',') : String(value ?? '');
      return `${key}=${flat}`;
    })
    .join('&');

  const expected = crypto.createHmac('sha256', clientSecret).update(message, 'utf8').digest('hex');
  return safeEqual(expected, provided);
}

/**
 * Verifies the `X-Shopify-Hmac-Sha256` header on an inbound webhook.
 *
 * The signature covers the raw bytes of the body. Not the parsed object, not a re-serialised
 * copy of it -- the exact bytes. `JSON.parse` followed by `JSON.stringify` changes key order,
 * whitespace and number formatting, and the signature then never matches. This is the single
 * most common way a Shopify webhook integration fails, and the reason the webhook route has to
 * be mounted with a raw body parser ahead of the global `express.json()`.
 *
 * The digest is base64 here, where the OAuth one is hex.
 */
export function verifyWebhook(rawBody: Buffer | string, header: unknown, clientSecret: string): boolean {
  if (typeof header !== 'string' || !header) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected = crypto.createHmac('sha256', clientSecret).update(body).digest('base64');
  return safeEqual(expected, header);
}

/**
 * A nonce for the OAuth `state` parameter.
 *
 * Its whole purpose is to prove the callback belongs to an install WE started. Without it,
 * anyone can send a merchant a crafted callback URL and have our server exchange a code they
 * chose -- which is how an attacker gets our app to store a token for a shop they control, or
 * binds their own shop to somebody else's tenant.
 */
export function generateNonce(): string {
  return crypto.randomBytes(24).toString('base64url');
}
