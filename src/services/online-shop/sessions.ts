import crypto from 'crypto';
import { prisma } from '../../lib/prisma';

/**
 * "Sign in with WhatsApp" for a shop's online store (29 Oct): the sign-ins themselves.
 *
 * A sign-in is made only from a number this browser has just proved with the WhatsApp code (see
 * account.ts start), lasts SIGNED_IN_DAYS, and is one row per device so a shopper can sign out of
 * one phone or all of them. The browser keeps the secret; this table keeps only its SHA-256.
 *
 * whoIs (otp.ts) reads these first, so everything that already trusts a proved browser -- saved
 * addresses, try-on notes, hearts, the checkout -- works with a signed-in one, unchanged.
 */
export const SIGNED_IN_DAYS = 90;
const SIGNED_IN_MS = SIGNED_IN_DAYS * 86_400_000;
/** Devices one number may be signed in on at one shop; the oldest goes when a new one comes. */
export const MAX_DEVICES = 10;
/** lastSeenAt is written at most this often, so reading a page is not a write every time. */
const SEEN_EVERY_MS = 60 * 60 * 1000;

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** "Chrome on Android" from a user agent, and nothing more of it. */
export function deviceOf(userAgent: unknown): string | null {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (!ua) return null;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  return browser && os ? `${browser} on ${os}` : browser ?? os;
}

/** A new sign-in for this number at this shop. Returns the secret the browser keeps. */
export async function create(clientId: string, phone: string, device: string | null, now = new Date()) {
  const token = `ss_${crypto.randomBytes(32).toString('base64url')}`;
  await prisma.onlineShopSession.create({
    data: { clientId, phone, tokenHash: hashOf(token), device, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + SIGNED_IN_MS) }
  });
  // Beyond MAX_DEVICES live sign-ins, the ones used longest ago are signed out.
  const live = await prisma.onlineShopSession.findMany({
    where: { clientId, phone, revokedAt: null, expiresAt: { gt: now } },
    orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }], select: { id: true }
  });
  if (live.length > MAX_DEVICES) {
    await prisma.onlineShopSession.updateMany({ where: { id: { in: live.slice(MAX_DEVICES).map(s => s.id) } }, data: { revokedAt: now } });
  }
  return token;
}

/** The number a live sign-in belongs to at this shop, or null (unknown, another shop's, signed out, run out). */
export async function phoneFor(clientId: string, token: string, now = new Date()): Promise<string | null> {
  if (!token.startsWith('ss_') || token.length < 30) return null;
  const row = await prisma.onlineShopSession.findUnique({
    where: { tokenHash: hashOf(token) },
    select: { id: true, clientId: true, phone: true, expiresAt: true, revokedAt: true, lastSeenAt: true }
  });
  if (!row || row.clientId !== clientId || row.revokedAt || row.expiresAt <= now) return null;
  if (now.getTime() - row.lastSeenAt.getTime() > SEEN_EVERY_MS) {
    await prisma.onlineShopSession.update({ where: { id: row.id }, data: { lastSeenAt: now } }).catch(() => null);
  }
  return row.phone;
}

export const isSignIn = (token: unknown) => typeof token === 'string' && token.startsWith('ss_');

/** Sign this device out. */
export async function revoke(clientId: string, token: string, now = new Date()) {
  await prisma.onlineShopSession.updateMany({ where: { clientId, tokenHash: hashOf(token), revokedAt: null }, data: { revokedAt: now } });
}

/**
 * Sign this number out everywhere at this shop: every device, and the browser pass a code check gave
 * (onlineShopPhoneCode.sessionToken), which would otherwise still open the address book.
 */
export async function revokeAll(clientId: string, phone: string, now = new Date()) {
  const { count } = await prisma.onlineShopSession.updateMany({ where: { clientId, phone, revokedAt: null }, data: { revokedAt: now } });
  await prisma.onlineShopPhoneCode.updateMany({ where: { clientId, phone }, data: { sessionToken: null, sessionExpiresAt: null } });
  return count;
}

/** Devices this number is signed in on now. */
export async function devices(clientId: string, phone: string, now = new Date()) {
  return prisma.onlineShopSession.count({ where: { clientId, phone, revokedAt: null, expiresAt: { gt: now } } });
}

/** Sign-ins nobody can use any more (run out or signed out over a month ago). Called by housekeeping. */
export async function forgetOldSessions(now = new Date()) {
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const { count } = await prisma.onlineShopSession.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: monthAgo } }] } });
  return count;
}
