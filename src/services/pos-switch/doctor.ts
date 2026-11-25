import { prisma } from '../../lib/prisma';
import { POS_ONLY } from '../../utils/posConnection';
import { posSwitchConfigured, status, switchOn, tillStore, SWITCH_TILL_NAME } from './index';

/**
 * The POS key doctor (25 Nov 2026, the owner: "whenever the key expires or any damage, it restores and reconnects;
 * nothing should break").
 *
 * A shop whose POS ScaleEzy switched on has ONE till key, named "POS", made by the switch and held only by POS.
 * Nobody touches it by hand any more, but it can still be damaged. For every such shop whose POS is ON (POS says so),
 * the doctor hands POS a fresh key -- exactly what "Turn POS on" does: new key at the store holding the stock, POS
 * swaps it in, the old one is retired -- when it finds:
 *
 *   NO_KEY       no working "POS" key (retired, paused or gone)
 *   STORE_CLOSED the key's store was switched off or removed
 *   STOCK_MOVED  the key's store holds nothing while another store holds the stock (Jyoti Atelier, 25 Nov)
 *   NOT_USED     POS has not used the key for STALE_MS though it pulls every 30 seconds (its copy lost or broken);
 *                silence is counted from the key's last use, its making, or this server's start, whichever is latest
 *   OLD_KEY_USED a till called with a retired or paused "POS" key: POS lost the newer one (repaired within seconds)
 *
 * It never acts while POS is unreachable or says the shop is switched off, never more than once per shop per
 * REPAIR_GAP_MS, and waits BACKOFF_MS after a repair POS never used (a second key would not help; that is POS's to fix).
 * Shops connected by hand (no "POS" key) are not touched. Keys never expire by time; only these can break one.
 */
/** POS pulls every shop it holds every 30 s, and fully every 30 min: two hours of silence means its key is not working. */
export const STALE_MS = 2 * 60 * 60 * 1000;
/** "Last used" is only written since this server started (and the column is new): never judge silence before that. */
const STARTED_AT = Date.now();
export const REPAIR_GAP_MS = 10 * 60 * 1000;
export const BACKOFF_MS = 6 * 60 * 60 * 1000;
export const EVERY_MS = 5 * 60 * 1000;
const BY = { userId: 'scaleezy-key-doctor', name: 'ScaleEzy (automatic key repair)' };

export type Finding = 'NO_KEY' | 'STORE_CLOSED' | 'STOCK_MOVED' | 'NOT_USED' | 'OLD_KEY_USED';
export type Outcome =
  | { clientId: string; action: 'healthy' }
  | { clientId: string; action: 'skipped'; why: string }
  | { clientId: string; action: 'repaired'; finding: Finding; keyPrefix?: string }
  | { clientId: string; action: 'failed'; finding: Finding; why: string };

const qtyAt = async (clientId: string, locationId: string) =>
  (await prisma.inventoryStock.aggregate({ where: { clientId, locationId, quantity: { gt: 0 } }, _sum: { quantity: true } }))._sum.quantity ?? 0;

/** What is wrong with this shop's switch key, if anything (no call to POS). */
export async function diagnose(clientId: string, now = Date.now(), oldKeyUsed = false): Promise<Finding | null> {
  const keys = await prisma.storefrontConnection.findMany({
    where: { clientId, ...POS_ONLY, name: SWITCH_TILL_NAME } as any,
    orderBy: { createdAt: 'desc' }, select: { id: true, status: true, locationIds: true, createdAt: true, lastUsedAt: true }
  });
  const working = keys.filter(k => k.status === 'ACTIVE' || k.status === 'PENDING_SYNC');
  if (!working.length) return 'NO_KEY';
  const key = working[0];
  const stores = await prisma.stockLocation.findMany({ where: { clientId, id: { in: key.locationIds }, active: true }, select: { id: true } });
  if (!stores.length) return 'STORE_CLOSED';
  const best = await tillStore(clientId);
  if (best && !key.locationIds.includes(best.id)) {
    const here = (await Promise.all(stores.map(s => qtyAt(clientId, s.id)))).reduce((a, b) => a + b, 0);
    if (here === 0 && (await qtyAt(clientId, best.id)) > 0) return 'STOCK_MOVED';
  }
  // An old key used while the current one is in use too is a stray call (a second POS worker, a call in flight at the
  // swap), not a till that lost its key: nothing to mend. "In use" = used within two write intervals.
  if (oldKeyUsed && (!key.lastUsedAt || now - key.lastUsedAt.getTime() > 10 * 60 * 1000)) return 'OLD_KEY_USED';
  const usedOrMade = Math.max(key.lastUsedAt?.getTime() ?? 0, key.createdAt.getTime(), STARTED_AT);
  if (now - usedOrMade > STALE_MS) return 'NOT_USED';
  return null;
}

const lastTry = new Map<string, number>();
/** For the doctor's own test: forget this process's recent attempts (the per-key gap still holds). */
export const forgetRecentRepairs = () => lastTry.clear();

/** Look at one shop and mend its key if it needs it. */
export async function checkShop(clientId: string, opts: { oldKeyUsed?: boolean; now?: number } = {}): Promise<Outcome> {
  const now = opts.now ?? Date.now();
  if (!posSwitchConfigured()) return { clientId, action: 'skipped', why: 'POS is not set up on this server' };
  const finding = await diagnose(clientId, now, opts.oldKeyUsed);
  if (!finding) return { clientId, action: 'healthy' };

  // Not twice in a row for nothing: one repair per shop per gap, and a long wait when POS never used the last one.
  const newest = await prisma.storefrontConnection.findFirst({
    where: { clientId, ...POS_ONLY, name: SWITCH_TILL_NAME } as any, orderBy: { createdAt: 'desc' }, select: { createdAt: true, lastUsedAt: true }
  });
  const sinceNewest = newest ? now - newest.createdAt.getTime() : Infinity;
  if (sinceNewest < REPAIR_GAP_MS || now - (lastTry.get(clientId) ?? 0) < REPAIR_GAP_MS) return { clientId, action: 'skipped', why: 'repaired a moment ago' };
  // The key POS should be using now: if POS never used even that one, another would not help yet.
  const handed = await prisma.storefrontConnection.findFirst({
    where: { clientId, ...POS_ONLY, name: SWITCH_TILL_NAME, status: { in: ['ACTIVE', 'PENDING_SYNC'] } } as any,
    orderBy: { createdAt: 'desc' }, select: { createdAt: true, lastUsedAt: true }
  });
  if (finding === 'NOT_USED' && handed && !handed.lastUsedAt && now - handed.createdAt.getTime() < BACKOFF_MS) {
    return { clientId, action: 'skipped', why: 'POS never used the last key; waiting before another' };
  }

  // Only while POS says this shop is ON. Unreachable or switched off: leave everything as it is.
  let pos: any;
  try { pos = await status(clientId); } catch (e: any) { return { clientId, action: 'skipped', why: `POS not reachable (${e?.message ?? e})` }; }
  if (pos?.posOn !== true) return { clientId, action: 'skipped', why: 'POS is switched off for this shop' };

  lastTry.set(clientId, now);
  try {
    const r: any = await switchOn(clientId, BY, null);
    console.log(`[pos-key-doctor] ${clientId}: ${finding} -> fresh key ${r?.tillKeyPrefix ?? ''} handed to POS`);
    return { clientId, action: 'repaired', finding, keyPrefix: r?.tillKeyPrefix };
  } catch (e: any) {
    console.warn(`[pos-key-doctor] ${clientId}: ${finding}, repair failed: ${e?.message ?? e}`);
    return { clientId, action: 'failed', finding, why: String(e?.message ?? e) };
  }
}

/** Every shop with a switch key, once. */
export async function runDoctor(now = Date.now()) {
  if (!posSwitchConfigured()) return [] as Outcome[];
  const shops = await prisma.storefrontConnection.findMany({ where: { ...POS_ONLY, name: SWITCH_TILL_NAME } as any, distinct: ['clientId'], select: { clientId: true } });
  const out: Outcome[] = [];
  for (const s of shops) out.push(await checkShop(s.clientId, { now }).catch((e: any) => ({ clientId: s.clientId, action: 'skipped' as const, why: String(e?.message ?? e) })));
  return out;
}

/** A till called with a retired/paused switch key: look at that shop in a few seconds (once, however many calls). */
const soon = new Map<string, NodeJS.Timeout>();
export function tillKeyRefused(clientId: string) {
  if (soon.has(clientId)) return;
  soon.set(clientId, setTimeout(() => {
    soon.delete(clientId);
    void checkShop(clientId, { oldKeyUsed: true }).catch(() => undefined);
  }, 3000));
}

let timer: NodeJS.Timeout | null = null;
/** Start the doctor (background jobs only). First look a minute after start, then every EVERY_MS. */
export function startPosKeyDoctor() {
  if (timer || !posSwitchConfigured()) return false;
  const tick = () => { void runDoctor().then(r => {
    const done = r.filter(o => o.action === 'repaired' || o.action === 'failed');
    if (done.length) console.log('[pos-key-doctor]', JSON.stringify(done));
  }).catch(e => console.warn('[pos-key-doctor] pass failed', e?.message ?? e)); };
  setTimeout(tick, 60_000).unref?.();
  timer = setInterval(tick, EVERY_MS);
  timer.unref?.();
  return true;
}
export function stopPosKeyDoctor() { if (timer) clearInterval(timer); timer = null; }
