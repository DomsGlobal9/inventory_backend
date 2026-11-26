import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma';
import { signingKey } from '../crm-identity/config';
import { posConnectionService } from '../pos/pos-connection.service';
import { POS_ONLY } from '../../utils/posConnection';

/**
 * POS switched on for a client automatically (25 Nov 2026, the owner; POS's spec D:/villy/pos/PLAN-boutique-pos-switch.md).
 *
 * One way in: Inventory owns every shop and till key, so whoever switches POS on -- a ScaleEzy super admin in the
 * Platform Console, or the Boutique app's super admin through the boutique API -- Inventory makes the till key and
 * calls POS once. POS makes (or joins) its shop, connects it, pulls the catalogue and makes the owner's login.
 *
 * Calls go to {POS_API_URL}/from-inventory/pos/..., signed with Inventory's OWN service key (the one CRM trusts):
 * RS256, kid, iss scaleezy-inventory, aud scaleezy-pos, 5 minutes, clientId, scope ['pos:setup'], onBehalfOf.
 *
 * Settings: POS_API_URL (e.g. https://pos.example/api/v1), INVENTORY_KEY_ID, INVENTORY_PRIVATE_KEY(_PATH). Until all
 * are set the switch says "POS is not set up here yet" and changes nothing.
 */
export const SWITCH_TILL_NAME = 'POS';

export class PosSwitchError extends Error {
  /** POS's own code for a refusal (details.code), e.g. NO_TILL_KEY. */
  public code?: string;
  constructor(public statusCode: number, message: string, code?: string) { super(message); this.code = code; }
}
const fail = (status: number, message: string, code?: string): never => { throw new PosSwitchError(status, message, code); };

type By = { userId: string; name?: string | null };
export type Owner = { name: string; email?: string | null; phone?: string | null };

function config() {
  const base = (process.env.POS_API_URL ?? '').replace(/\/+$/, '');
  const kid = process.env.INVENTORY_KEY_ID ?? '';
  const key = base && kid ? signingKey() : null;
  return base && kid && key ? { base, kid, key } : null;
}
export const posSwitchConfigured = () => config() !== null;

async function callPos<T>(method: 'GET' | 'POST', path: string, clientId: string, by: By | null, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const cfg = config();
  if (!cfg) fail(503, 'POS is not set up here yet (POS_API_URL and Inventory\'s service key).');
  const token = jwt.sign(
    { clientId, scope: ['pos:setup'], ...(by ? { onBehalfOf: { userId: by.userId, ...(by.name ? { name: by.name } : {}) } } : {}) },
    cfg!.key as any,
    { algorithm: 'RS256', issuer: 'scaleezy-inventory', audience: 'scaleezy-pos', keyid: cfg!.kid, expiresIn: '5m' }
  );
  let res: Response;
  try {
    res = await fetch(`${cfg!.base}/from-inventory/pos${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e: any) {
    return fail(503, 'POS could not be reached just now. Nothing was changed there; try again in a minute.');
  }
  const data: any = await res.json().catch(() => null);
  if (res.ok) return (data?.data ?? data) as T;
  // A 503 that carries POS's own code (SETUP_OFF, INVENTORY_UNREACHABLE, ...) is a sentence POS wrote for people:
  // passed on. A crash (500, 502, no code) never is: its text may be anything (25 Nov 2026, found by POS).
  const posCode = data?.details?.code ?? data?.error?.code;
  if (res.status === 503 && typeof posCode === 'string' && typeof data?.message === 'string' && data.message.trim()) fail(503, data.message.trim().slice(0, 300));
  if (res.status >= 500) fail(503, 'POS could not finish just now. Try again in a minute.');
  // POS's own refusal, in its own words (it writes them for people).
  return fail(res.status === 404 ? 404 : 409, String(data?.message ?? data?.error?.message ?? 'POS refused this.'), typeof posCode === 'string' ? posCode : undefined);
}

/**
 * The store a till sells from: the switched-on store that holds the stock. The main store when it holds any (or when
 * no store holds any yet), else the store holding the most. Found live on 25 Nov 2026: Jyoti Atelier's till was given
 * its old EMPTY "Main Store" while every piece sat in "Boutique - 1", so its first sale would have come off nothing.
 */
export async function tillStore(clientId: string) {
  const stores = await prisma.stockLocation.findMany({ where: { clientId, active: true }, select: { id: true, code: true, type: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
  if (!stores.length) return null;
  const held = await prisma.inventoryStock.groupBy({ by: ['locationId'], where: { clientId, locationId: { in: stores.map(s => s.id) }, quantity: { gt: 0 } }, _sum: { quantity: true } });
  const qty = new Map(held.map(h => [h.locationId, h._sum.quantity ?? 0]));
  const main = stores.find(s => s.code === 'MAIN-STORE');
  if (main && (qty.get(main.id) ?? 0) > 0) return { id: main.id };
  const richest = [...stores].sort((a, b) => (qty.get(b.id) ?? 0) - (qty.get(a.id) ?? 0))[0];
  if ((qty.get(richest.id) ?? 0) > 0) return { id: richest.id };
  return { id: (main ?? stores.find(s => String(s.type) === 'STORE') ?? stores[0]).id };
}

/** The shop's owner as POS needs them: given, else the shop's first owner login. */
async function ownerOf(clientId: string, given?: Partial<Owner> | null): Promise<Owner | null> {
  const name = String(given?.name ?? '').trim();
  if (name) return { name: name.slice(0, 120), email: given?.email ? String(given.email).trim() : null, phone: given?.phone ? String(given.phone).trim() : null };
  const u = await prisma.user.findFirst({
    where: { clientId, status: 'ACTIVE', roles: { some: { role: { name: 'SUPER_ADMIN' } } } },
    orderBy: { createdAt: 'asc' }, select: { name: true, email: true, phone: true }
  }) ?? await prisma.user.findFirst({ where: { clientId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, select: { name: true, email: true, phone: true } });
  return u ? { name: u.name ?? 'Owner', email: u.email, phone: u.phone ?? null } : null;
}

async function shopNameOf(clientId: string) {
  const [s, b] = await Promise.all([
    prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } }),
    prisma.boutiqueLink.findUnique({ where: { clientId }, select: { shopName: true } })
  ]);
  return s?.businessName?.trim() || b?.shopName?.trim() || clientId;
}

export async function status(clientId: string) {
  if (!posSwitchConfigured()) return { configured: false as const };
  return { configured: true as const, ...(await callPos<Record<string, unknown>>('GET', '/status', clientId, null)) };
}

/**
 * Switch POS on. A fresh till key named "POS" is made for the shop's store and handed to POS; POS makes or joins its
 * shop with it. Refused by POS: the new key is taken back at once. Accepted: an older key this switch made is retired
 * (POS now holds the new one). Sent again: POS makes nothing twice.
 */
export async function switchOn(clientId: string, by: By, givenOwner?: Partial<Owner> | null) {
  if (!posSwitchConfigured()) fail(503, 'POS is not set up here yet (POS_API_URL and Inventory\'s service key).');
  const store = await tillStore(clientId);
  if (!store) fail(409, 'This shop has no store switched on. Add or switch on a store first.');
  const owner = await ownerOf(clientId, givenOwner);
  if (givenOwner?.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(givenOwner.email).trim())) fail(400, 'That owner email does not look right.');
  const shopName = await shopNameOf(clientId);
  const earlier = await prisma.storefrontConnection.findMany({ where: { clientId, ...POS_ONLY, name: SWITCH_TILL_NAME, status: 'ACTIVE' }, select: { id: true } });
  const till = await posConnectionService.create(clientId, { locationId: store!.id, name: SWITCH_TILL_NAME });
  let answer: Record<string, unknown>;
  try {
    answer = await callPos<Record<string, unknown>>('POST', '/enable', clientId, by, { shopName, tillKey: till.key, ...(owner ? { owner } : {}) });
  } catch (e) {
    await posConnectionService.disconnect(clientId, till.id).catch(() => undefined);
    throw e;
  }
  for (const old of earlier) await posConnectionService.disconnect(clientId, old.id).catch(() => undefined);
  return { ...answer, tillKeyPrefix: till.keyPrefix };
}

/**
 * One-switch onboarding (26 Nov 2026, PLAN-onboarding-modules.md): tell POS the client's modules, the whole picture
 * (services/client-modules builds `body`: clientId, version, modules, owner, stores...). POS ignores an older version.
 *   - Inventory on: POS needs a till key. One is made only when the shop has no working "POS" key (the key doctor
 *     keeps the one it has); otherwise none is sent and POS keeps its key.
 *   - Inventory off (a POS-only client): no key; POS runs the shop with no Inventory link, and Inventory's "POS" keys
 *     are retired (nothing at Inventory for a till to reach).
 */
export async function connect(clientId: string, body: Record<string, any>, by: By | null) {
  if (!posSwitchConfigured()) fail(503, 'POS is not set up here yet (POS_API_URL and Inventory\'s service key).');
  const withInventory = Array.isArray(body.modules) && body.modules.includes('inventory');
  const working = await prisma.storefrontConnection.findMany({ where: { clientId, ...POS_ONLY, name: SWITCH_TILL_NAME, status: { in: ['ACTIVE', 'PENDING_SYNC'] } } as any, select: { id: true } });
  let fresh: { id: string; key: string; keyPrefix: string } | null = null;
  if (withInventory && !working.length) {
    const store = await tillStore(clientId);
    if (!store) fail(409, 'This shop has no store switched on. Add or switch on a store first.');
    fresh = await posConnectionService.create(clientId, { locationId: store!.id, name: SWITCH_TILL_NAME });
  }
  const owner = body.owner?.name ? body.owner : await ownerOf(clientId);
  const shopName = body.shopName ?? await shopNameOf(clientId);
  const enable = (key: { key: string } | null) => callPos<Record<string, unknown>>('POST', '/enable', clientId, by, { ...body, shopName, ...(owner ? { owner } : {}), ...(key ? { tillKey: key.key } : {}) });
  let answer: Record<string, unknown>;
  try {
    try {
      answer = await enable(fresh);
    } catch (e) {
      // POS wants a key with every enable while Inventory is on: give it a fresh one (the old one is retired below).
      if (!(e instanceof PosSwitchError && e.code === 'NO_TILL_KEY' && withInventory && !fresh)) throw e;
      const store = await tillStore(clientId);
      if (!store) fail(409, 'This shop has no store switched on. Add or switch on a store first.');
      fresh = await posConnectionService.create(clientId, { locationId: store!.id, name: SWITCH_TILL_NAME });
      answer = await enable(fresh);
    }
  } catch (e) {
    if (fresh) await posConnectionService.disconnect(clientId, fresh.id).catch(() => undefined);
    throw e;
  }
  // A fresh key handed over: POS now holds it, so the older ones are retired.
  if (fresh) for (const k of working) await posConnectionService.disconnect(clientId, k.id).catch(() => undefined);
  if (!withInventory) for (const k of working) await posConnectionService.disconnect(clientId, k.id).catch(() => undefined);
  return { ...answer, ...(fresh ? { tillKeyPrefix: fresh.keyPrefix } : {}) };
}

/** POS switched off for the client (the whole picture, changed.off has "pos"). A shop POS never had counts as done. */
export async function disconnect(clientId: string, body: Record<string, any>, by: By | null) {
  try {
    return await callPos<Record<string, unknown>>('POST', '/disable', clientId, by, body);
  } catch (e) {
    if (e instanceof PosSwitchError && e.statusCode === 404) return { posOn: false, neverSetUp: true };
    throw e;
  }
}

/** POS's own lines for the Console's checklist; null when this POS has no such door yet. */
export async function connection(clientId: string): Promise<{ lines: any[] } | null> {
  try {
    return await callPos<{ lines: any[] }>('GET', '/connection', clientId, null, undefined, 6_000);
  } catch (e) {
    if (e instanceof PosSwitchError && e.statusCode === 404) return null;
    throw e;
  }
}

export async function switchOff(clientId: string, by: By) {
  return callPos<Record<string, unknown>>('POST', '/disable', clientId, by, {});
}

export async function ownerLink(clientId: string, by: By, reset = false) {
  return callPos<Record<string, unknown>>('POST', '/owner-link', clientId, by, reset ? { reset: true } : {});
}

// A new key for a shop that has POS: made automatically. The key doctor (./doctor.ts) hands POS a fresh one whenever the
// key is lost, retired, on a closed or empty store, or unused by POS; ScaleEzy pressing "Turn POS on" again does the
// same. The shop itself never makes or changes keys (25 Nov 2026).
