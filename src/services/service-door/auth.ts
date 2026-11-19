import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { getPermission } from '../../config/permissions';
import { DOOR_SCOPES } from './catalogue';

/**
 * Who may come through Inventory's service door: another ScaleEzy module, with a short pass it signs with its OWN
 * key (RS256, kid in the header), checked by verifyServiceToken against TRUSTED_SERVICES_KEYS (Inventory holds only
 * public keys; a key may be held to some scopes there). On top of that, here:
 *   - a pass lasts at most 10 minutes, and names its shop (clientId), which must be a shop on ScaleEzy;
 *   - what a module may do is what its pass asks for, cut down to the door's permissions: never the owner's
 *     "everything" (*), never a retired key, never anything the door does not offer;
 *   - the request then looks, to the app's own routes, like a person holding exactly those permissions, named
 *     "<module>" (or "<person> (<module>)" when the pass says who it is for);
 *   - each module has a fair share per shop: 600 calls a minute.
 */
const MAX_LIFETIME_S = 600;
const RATE = 10, BURST = 600;
const buckets = new Map<string, { tokens: number; at: number }>();
const shops = new Map<string, { ok: boolean; at: number }>();
const say = (res: Response, status: number, message: string) => res.status(status).json({ success: false, message });

async function shopExists(clientId: string) {
  const hit = shops.get(clientId);
  if (hit && (hit.ok || Date.now() - hit.at < 30_000)) return hit.ok;
  const ok = !!(await prisma.user.findFirst({ where: { clientId }, select: { id: true } }))
    || !!(await prisma.stockLocation.findFirst({ where: { clientId }, select: { id: true } }));
  shops.set(clientId, { ok, at: Date.now() });
  if (shops.size > 5_000) shops.clear();
  return ok;
}

function take(key: string) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE);
  b.at = now;
  buckets.set(key, b);
  if (buckets.size > 10_000) buckets.clear();
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
export const resetDoorLimits = () => { buckets.clear(); shops.clear(); };

/** After verifyServiceToken. */
export async function doorAuth(req: Request, res: Response, next: NextFunction) {
  const s = (req as any).service as { id: string; issuer: string; scopes: string[]; clientId?: string; onBehalfOf?: { userId: string; name?: string }; issuedAt?: number; expiresAt?: number } | undefined;
  if (!s) return say(res, 401, 'Send a service pass: Authorization: Bearer <a token signed with your module\'s key>.');
  if (typeof s.issuedAt !== 'number' || typeof s.expiresAt !== 'number' || s.expiresAt - s.issuedAt > MAX_LIFETIME_S) {
    return say(res, 401, `A service pass may last at most ${MAX_LIFETIME_S / 60} minutes. Sign a new one.`);
  }
  if (typeof s.clientId !== 'string' || !s.clientId) return say(res, 400, 'Say which shop: the pass needs clientId.');
  if (!(await shopExists(s.clientId))) return say(res, 404, 'That shop is not on ScaleEzy.');

  const scopes = s.scopes.filter(k => typeof k === 'string' && k !== '*' && DOOR_SCOPES.includes(k) && !(getPermission(k) as any)?.retired);
  const by = s.onBehalfOf && typeof s.onBehalfOf.userId === 'string' ? s.onBehalfOf : null;
  (req as any).user = {
    id: by?.userId ?? `service:${s.issuer}`,
    clientId: s.clientId,
    name: by?.name ? `${by.name} (${s.issuer})` : s.issuer,
    permissions: scopes,
    roles: [],
    locationIds: [],
    service: s.issuer
  };
  res.setHeader('X-Inventory-Service', s.issuer);
  res.setHeader('X-Inventory-Service-Api', '1');
  if (!take(`${s.issuer}|${s.clientId}`)) {
    res.setHeader('Retry-After', '5');
    return say(res, 429, `The module "${s.issuer}" is calling Inventory too often for this shop (600 a minute at most). Wait a few seconds and try again.`);
  }
  next();
}
