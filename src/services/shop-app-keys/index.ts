import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma';

/**
 * Partner app keys for Shop API v1 (/shop/v1, 20 Nov 2026, PLAN-shop-api.md).
 *
 * A key says WHICH APP is calling (the Boutique app), so its traffic can be told apart and switched off in one place.
 * It does not open a closed shop: each shop's own Online shop switch still decides. A key is for ONE boutique account
 * (tenant), reaching only the shops linked to it; or, for the Boutique app itself (26 Nov 2026, the owner: "one app
 * serves all its clients, one key is enough"), for EVERY boutique (tenant ALL): it reaches any shop linked to a
 * boutique account, never a shop that is not (ScaleEzy's own retail shops). That is the reach the Boutique app's
 * signed pass already has on the boutique API.
 *
 * The key is `sak_<prefix>_<secret>`, shown once when made; only a SHA-256 of the whole key is kept, and the prefix
 * (not secret) finds the row, so a key can be recognised in a support call without anyone holding it.
 */
export class AppKeyError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }

const hash = (key: string) => crypto.createHash('sha256').update(key).digest('hex');
const KEY = /^sak_([a-z0-9]{10})_([A-Za-z0-9_-]{32,64})$/;
/** The tenant of a key for every boutique (the Boutique app itself). Not a valid boutique account name. */
export const ALL = '*';

export function view(k: { id: string; name: string; tenant: string; keyPrefix: string; active: boolean; createdAt: Date; switchedAt: Date | null; lastUsedAt: Date | null; createdBy: string | null }) {
  return { id: k.id, name: k.name, tenant: k.tenant, allBoutiques: k.tenant === ALL, keyStartsWith: `sak_${k.keyPrefix}_`, active: k.active, createdAt: k.createdAt, switchedAt: k.switchedAt, lastUsedAt: k.lastUsedAt, createdBy: k.createdBy };
}

/**
 * A new key for an app: for every boutique ({ allBoutiques: true }) or for one boutique account ({ tenant }).
 * The answer holds the key itself: the only time it is ever shown.
 */
export async function make(input: { name?: unknown; tenant?: unknown; allBoutiques?: unknown }, by: string | null) {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  if (!name) throw new AppKeyError('Name the app, for example "Boutique app".');
  if (input.allBoutiques !== undefined && typeof input.allBoutiques !== 'boolean') throw new AppKeyError('"allBoutiques" is true or false.');
  const given = typeof input.tenant === 'string' ? input.tenant.trim().toLowerCase() : '';
  if (input.allBoutiques === true && given) throw new AppKeyError('Choose one: every boutique, or one boutique account, not both.');
  let tenant = ALL;
  if (input.allBoutiques !== true) {
    tenant = given;
    if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(tenant)) throw new AppKeyError('Say which boutique account the key is for (its tenant, like lakshmi-boutique), or make it for every boutique.');
    if (!(await prisma.boutiqueLink.count({ where: { tenant } }))) throw new AppKeyError(`No shop is linked to the boutique account "${tenant}" yet.`, 404);
  }
  const prefix = crypto.randomBytes(8).toString('hex').slice(0, 10);
  const secret = crypto.randomBytes(30).toString('base64url');
  const key = `sak_${prefix}_${secret}`;
  const row = await prisma.shopAppKey.create({ data: { name, tenant, keyPrefix: prefix, keyHash: hash(key), createdBy: by } });
  return { ...view(row), key };
}

export async function list(tenant?: unknown) {
  const rows = await prisma.shopAppKey.findMany({ where: typeof tenant === 'string' && tenant ? { tenant: tenant.toLowerCase() } : {}, orderBy: { createdAt: 'desc' } });
  return rows.map(view);
}

export async function setActive(id: string, active: boolean) {
  const row = await prisma.shopAppKey.findUnique({ where: { id } });
  if (!row) throw new AppKeyError('That app key does not exist.', 404);
  const now = await prisma.shopAppKey.update({ where: { id }, data: { active, switchedAt: new Date() } });
  forget(row.keyPrefix);
  return view(now);
}

/* ── checking a key on every call, without a database read each time ─────────────────────────── */
type Known = { id: string; name: string; tenant: string; active: boolean; hash: string; at: number };
const cache = new Map<string, Known>();
const TTL_MS = 30_000; // a key switched off stops working within 30 seconds on every server, at once on this one
const forget = (prefix: string) => cache.delete(prefix);
let lastTouch = new Map<string, number>();

/** The app behind a key, or why not. Constant-time comparison of the hash. */
export async function check(raw: unknown): Promise<{ ok: true; app: { id: string; name: string; tenant: string } } | { ok: false; why: string }> {
  const key = typeof raw === 'string' ? raw.trim() : '';
  const m = KEY.exec(key);
  if (!m) return { ok: false, why: 'Send the app key in X-Shop-App-Key.' };
  const prefix = m[1];
  let k = cache.get(prefix);
  if (!k || Date.now() - k.at > TTL_MS) {
    const row = await prisma.shopAppKey.findUnique({ where: { keyPrefix: prefix } });
    if (!row) { cache.delete(prefix); return { ok: false, why: 'That app key is not known.' }; }
    k = { id: row.id, name: row.name, tenant: row.tenant, active: row.active, hash: row.keyHash, at: Date.now() };
    cache.set(prefix, k);
  }
  const given = Buffer.from(hash(key)), kept = Buffer.from(k.hash);
  if (given.length !== kept.length || !crypto.timingSafeEqual(given, kept)) return { ok: false, why: 'That app key is not known.' };
  if (!k.active) return { ok: false, why: 'This app key has been switched off by ScaleEzy.' };
  // When it was last used, at most once a minute per key: enough for the Console, no write per call.
  if (Date.now() - (lastTouch.get(k.id) ?? 0) > 60_000) {
    lastTouch.set(k.id, Date.now());
    void prisma.shopAppKey.update({ where: { id: k.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return { ok: true, app: { id: k.id, name: k.name, tenant: k.tenant } };
}

/** Whether a shop (by its online-shop clientId) is linked to this boutique account right now (ALL: to any). */
export async function shopIsTenants(clientId: string, tenant: string) {
  return (await prisma.boutiqueLink.count({ where: { clientId, ...(tenant === ALL ? {} : { tenant }), unlinkedAt: null } })) > 0;
}

/** For tests: forget every cached key. */
export function resetCache() { cache.clear(); lastTouch = new Map(); }
