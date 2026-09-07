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
  const prefix = randomToken(PREFIX_BYTES);
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

/** The prefix of a presented credential, so the right connection can be found before verifying. */
export function prefixOf(plaintext: string): string | null {
  const parts = plaintext.split('_');
  if (parts.length !== 3 || parts[0] !== 'sk') return null;
  return parts[1] || null;
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
