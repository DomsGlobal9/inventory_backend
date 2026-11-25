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
  constructor(public statusCode: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new PosSwitchError(status, message); };

type By = { userId: string; name?: string | null };
export type Owner = { name: string; email?: string | null; phone?: string | null };

function config() {
  const base = (process.env.POS_API_URL ?? '').replace(/\/+$/, '');
  const kid = process.env.INVENTORY_KEY_ID ?? '';
  const key = base && kid ? signingKey() : null;
  return base && kid && key ? { base, kid, key } : null;
}
export const posSwitchConfigured = () => config() !== null;

async function callPos<T>(method: 'GET' | 'POST', path: string, clientId: string, by: By | null, body?: unknown): Promise<T> {
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
      signal: AbortSignal.timeout(60_000)
    });
  } catch (e: any) {
    return fail(503, 'POS could not be reached just now. Nothing was changed there; try again in a minute.');
  }
  const data: any = await res.json().catch(() => null);
  if (res.ok) return (data?.data ?? data) as T;
  if (res.status >= 500) fail(503, 'POS could not finish just now. Try again in a minute.');
  // POS's own refusal, in its own words (it writes them for people).
  return fail(res.status === 404 ? 404 : 409, String(data?.message ?? data?.error?.message ?? 'POS refused this.'));
}

/** The store a till sells from: the main store, or the oldest store that is switched on. */
async function tillStore(clientId: string) {
  return await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE', active: true }, select: { id: true } })
    ?? await prisma.stockLocation.findFirst({ where: { clientId, active: true, type: 'STORE' as any }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    ?? await prisma.stockLocation.findFirst({ where: { clientId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
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

export async function switchOff(clientId: string, by: By) {
  return callPos<Record<string, unknown>>('POST', '/disable', clientId, by, {});
}

export async function ownerLink(clientId: string, by: By, reset = false) {
  return callPos<Record<string, unknown>>('POST', '/owner-link', clientId, by, reset ? { reset: true } : {});
}

/**
 * Settings → POS replaced a till key: a shop that POS was switched on for gets the new key at once, so the counter
 * keeps billing. Never blocks the replacement: when POS cannot be told, the owner is told instead.
 */
export async function afterKeyReplaced(clientId: string, newKey: string, by: By): Promise<{ posTold: boolean; note?: string }> {
  if (!posSwitchConfigured()) return { posTold: false };
  try {
    const s = await callPos<{ posOn?: boolean }>('GET', '/status', clientId, null);
    if (!s?.posOn) return { posTold: false };
    await callPos('POST', '/enable', clientId, by, { shopName: await shopNameOf(clientId), tillKey: newKey });
    return { posTold: true };
  } catch (e: any) {
    return { posTold: false, note: `POS could not be given the new key just now (${e?.message ?? 'no answer'}). Switch POS on again from the Console to hand it over.` };
  }
}
