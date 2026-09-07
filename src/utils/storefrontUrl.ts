import dns from 'dns/promises';
import net from 'net';

/**
 * Validating a merchant-supplied webhook destination.
 *
 * The merchant types the URL and our server makes the request, which is server-side request
 * forgery by construction. Without checks, "https://my-shop.example" can be swapped for
 * `http://169.254.169.254/latest/meta-data/` (cloud instance credentials) or
 * `http://127.0.0.1:5432` (our own database), and we would dutifully connect from inside the
 * network and hand back whatever came out.
 *
 * Two checks, at two moments, because either alone is insufficient:
 *
 *   - on save, so a merchant gets a clear error while they are looking at the form;
 *   - again at send time, because DNS can be re-pointed at a private address after the URL
 *     passed validation. That is the whole trick behind DNS rebinding.
 */

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

/** Development only. Never permitted when NODE_ENV is production. */
const ALLOW_LOCAL = process.env.NODE_ENV !== 'production';

/**
 * Ranges that must never be reachable from a merchant-supplied URL: loopback, link-local
 * (which is where cloud metadata services live), private networks, and the unique-local IPv6
 * range.
 */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // loopback
    if (a === 0) return true;                           // "this network"
    if (a === 169 && b === 254) return true;            // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;  // carrier-grade NAT
    if (a >= 224) return true;                          // multicast and reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;                   // loopback, unspecified
    if (v.startsWith('fe80')) return true;                        // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true;    // unique local
    // IPv4 written inside IPv6, e.g. ::ffff:127.0.0.1
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  return true; // unparseable: refuse rather than guess
}

/** Shape and scheme. Cheap, and enough to reject most mistakes at the point of typing. */
export function checkUrlShape(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }

  if (url.protocol !== 'https:') {
    if (url.protocol === 'http:' && ALLOW_LOCAL) return { ok: true };
    return { ok: false, reason: 'The address must start with https:// so stock data is encrypted in transit.' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'Remove the username and password from the address.' };
  }

  return { ok: true };
}

/**
 * Resolve and confirm every address the hostname points at is public.
 *
 * Every address, not the first: a hostname can resolve to one public and one private address,
 * and a client that tries them in turn would reach the private one.
 */
export async function checkUrlDestination(raw: string): Promise<UrlCheck> {
  const shape = checkUrlShape(raw);
  if (!shape.ok) return shape;

  const url = new URL(raw);
  const host = url.hostname;

  // A literal IP needs no lookup, and must be checked directly.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      if (ALLOW_LOCAL) return { ok: true };
      return { ok: false, reason: 'That address is on a private network and cannot be reached from here.' };
    }
    return { ok: true };
  }

  let addresses: string[];
  try {
    const records = await dns.lookup(host, { all: true });
    addresses = records.map(r => r.address);
  } catch {
    return { ok: false, reason: `The address ${host} could not be found.` };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `The address ${host} did not resolve.` };
  }

  const priv = addresses.filter(isPrivateAddress);
  if (priv.length > 0) {
    if (ALLOW_LOCAL) return { ok: true };
    return { ok: false, reason: 'That address resolves to a private network and cannot be reached from here.' };
  }

  return { ok: true };
}
