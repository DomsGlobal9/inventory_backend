import crypto from 'crypto';

/**
 * Credentials for a storefront connection.
 *
 * The secret is generated here, shown to the merchant once, and never stored. Only its hash is
 * kept, so a leak of the connections table does not hand anyone the ability to impersonate us
 * to every merchant we integrate with -- which is exactly what the previous design did by
 * sending INTERNAL_SERVICE_KEY, the secret that also guards inbound internal calls, to every
 * storefront as a static header.
 *
 * A short non-secret prefix travels with it so a credential can be named in the UI, matched in
 * a log line, and looked up in one indexed query without printing anything usable.
 */

/** `sk_` for "storefront key", then the prefix, then the secret body. */
const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;

export interface GeneratedCredential {
  /** Shown to the merchant exactly once. Never persisted. */
  plaintext: string;
  /** Stored, and what an incoming credential is checked against. */
  hash: string;
  /** Stored, safe to display and to log. */
  prefix: string;
}

/** base64url, so a credential survives being pasted into a header, a query string or a shell. */
function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function generateCredential(): GeneratedCredential {
  // Hex, not base64url: the underscore is the field separator, and base64url's alphabet
  // contains one. A prefix that happened to include an underscore split into two fields and
  // the credential could never be looked up again -- for the prefix that is one credential in
  // eight, silently unusable from the moment it was issued.
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomToken(SECRET_BYTES);
  const plaintext = `sk_${prefix}_${secret}`;
  return { plaintext, hash: hashCredential(plaintext), prefix };
}

/**
 * SHA-256 rather than a password hash such as bcrypt, deliberately.
 *
 * These are 256 bits of machine-generated randomness, not a human-chosen password: there is no
 * dictionary to attack and nothing to slow an attacker down for. A slow hash here would only
 * add latency to every storefront request while buying no security, and the read API is on the
 * hot path for a website's page loads.
 */
export function hashCredential(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * The prefix of a presented credential, so the right connection can be found before verifying.
 *
 * Read positionally -- `sk_`, then up to the next underscore -- rather than by splitting on
 * every underscore. The secret is base64url, whose alphabet includes the underscore, so a
 * secret containing one produced four fields instead of three and this returned null. The
 * connection was then never looked up and the credential was rejected as invalid, no matter
 * how correct it was. About half of all issued keys were affected: the hash matched perfectly
 * and the request was still refused, which reads as "the key is wrong" rather than "we cannot
 * parse it". The secret's own content is never parsed -- the hash covers the whole string.
 */
export function prefixOf(plaintext: string): string | null {
  if (!plaintext.startsWith('sk_')) return null;
  const rest = plaintext.slice(3);
  const separator = rest.indexOf('_');
  // Nothing before the separator is no prefix; nothing after it is no secret.
  if (separator <= 0 || separator === rest.length - 1) return null;
  return rest.slice(0, separator);
}

/**
 * Constant-time comparison. A plain `===` leaks how much of a hash matched through timing,
 * which over enough requests is enough to recover it a byte at a time.
 */
export function credentialMatches(plaintext: string, storedHash: string): boolean {
  const presented = Buffer.from(hashCredential(plaintext), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (presented.length !== stored.length) return false;
  return crypto.timingSafeEqual(presented, stored);
}
