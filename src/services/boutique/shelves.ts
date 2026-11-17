/**
 * Racks and shelves for the boutique (CRM-B checklist section 3, 16 Nov 2026) on ScaleEzy's own shelves -- the
 * same spots, labels, put-aways, counts and problems the shop's Shelves screens use, so nothing is kept twice and
 * a boutique that later joins ScaleEzy finds its racks already there.
 *
 * This file only translates: the boutique's item codes to our colours and back, its quantities (12.5 m) to our
 * base units (1250 cm) and back. Every rule -- 4 levels, only the last level holds stock, labels that never change,
 * capacity warnings, stock leaving takes "not shelved" first then shelves in walking order, problems raised and fixed
 * -- is the shelves' own, unchanged.
 *
 * Shelves are physical: a shelf in a shop that also sells ready-made pieces may hold the shop's own items too. They
 * are shown (itemCode null, scaleezyItem true) because a shelf count has to see everything on the shelf.
 */
import { prisma } from '../../lib/prisma';
import { factorOf, type SoldBy } from '../../lib/units';
import { spotService } from '../shelves/spot.service';
import { shelfStockService } from '../shelves/shelf-stock.service';
import { shelfCountService } from '../shelves/count.service';
import { shelfIssueService } from '../shelves/issue.service';
import { createSpotSchema, bulkSpotsSchema, updateSpotSchema } from '../shelves/shelf.schema';
import { type Actor, problem, baseQty, variantOf, storeOf, codeOf } from './index';

export const mustShelve = (a: Actor) => { if (!a.can.includes('stock:write') && !a.can.includes('stock:transfer')) throw problem('This person may not move stock on shelves.', 403); };
export const mustSetUp = (a: Actor) => { if (!a.can.includes('stock:write')) throw problem('This person may not set up racks and shelves.', 403); };

/** zod's first message as a plain 400, the way the shelves screens show it. */
function parsed<T>(schema: { safeParse: (v: unknown) => any }, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw problem(r.error.issues?.[0]?.message ?? 'Check what was sent.');
  return r.data;
}

/** Errors from the shelves services carry statusCode/message already; anything else is passed on. */
async function shelf<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    if (e?.statusCode || e?.status) throw problem(e.message, e.statusCode ?? e.status);
    throw e;
  }
}

const QTY_KEYS = new Set(['quantity', 'total', 'held', 'onShelves', 'notShelved', 'counted', 'before', 'after', 'difference', 'expected', 'found', 'moved']);

/**
 * Walks a shelves answer: where it finds a colour (variantId), adds the boutique's itemCode and unit, and turns that
 * colour's quantities (and those nested under it) from base units into the item's unit.
 */
async function inBoutiqueUnits<T>(clientId: string, value: T): Promise<T> {
  const ids = new Set<string>();
  const collect = (n: any) => {
    if (Array.isArray(n)) return n.forEach(collect);
    if (n && typeof n === 'object') { if (typeof n.variantId === 'string') ids.add(n.variantId); Object.values(n).forEach(collect); }
  };
  collect(value);
  const vs = ids.size ? await prisma.productVariant.findMany({ where: { clientId, id: { in: [...ids] } }, select: { id: true, boutiqueRef: true, product: { select: { soldBy: true } } } }) : [];
  const byId = new Map(vs.map(v => [v.id, v]));
  const walk = (n: any, f: number | null): any => {
    if (Array.isArray(n)) return n.map(x => walk(x, f));
    if (!n || typeof n !== 'object' || n instanceof Date) return n;
    let here = f;
    const out: any = {};
    const v = typeof n.variantId === 'string' ? byId.get(n.variantId) : undefined;
    if (v) {
      here = factorOf((v.product.soldBy ?? 'PIECE') as SoldBy);
      out.itemCode = codeOf(v.boutiqueRef) ?? null;
      out.unit = v.product.soldBy;
      if (!v.boutiqueRef) out.scaleezyItem = true;
    }
    for (const [k, x] of Object.entries(n)) out[k] = (here && QTY_KEYS.has(k) && typeof x === 'number') ? x / here : walk(x, here);
    return out;
  };
  return walk(value, null);
}

/* ── racks: set-up ──────────────────────────────────────────────────────────────────────────────── */

export async function tree(actor: Actor, locationId: string) {
  await storeOf(actor.clientId, locationId, undefined, true);
  return shelf(() => spotService.tree(actor.clientId, locationId));
}
export async function addSpot(actor: Actor, locationId: string, body: unknown) {
  mustSetUp(actor);
  await storeOf(actor.clientId, locationId);
  return shelf(() => spotService.create(actor.clientId, locationId, parsed(createSpotSchema, body), null));
}
/** Describe the store in one go: levels with ranges; preview: true shows what would be made; running it again adds only what is missing. */
export async function addSpots(actor: Actor, locationId: string, body: unknown) {
  mustSetUp(actor);
  await storeOf(actor.clientId, locationId);
  return shelf(() => spotService.bulk(actor.clientId, locationId, parsed(bulkSpotsSchema, body), null));
}
async function ownSpot(actor: Actor, spotId: string) {
  const s = await prisma.storageSpot.findFirst({ where: { id: spotId, clientId: actor.clientId }, select: { id: true } });
  if (!s) throw problem('That shelf is not in this shop.', 404);
}
export async function changeSpot(actor: Actor, spotId: string, body: unknown) {
  mustSetUp(actor);
  await ownSpot(actor, spotId);
  return shelf(() => spotService.update(actor.clientId, spotId, parsed(updateSpotSchema, body), null));
}
export async function removeSpot(actor: Actor, spotId: string) {
  mustSetUp(actor);
  await ownSpot(actor, spotId);
  return shelf(() => spotService.remove(actor.clientId, spotId));
}
/** QR labels: each spot's fixed label code (never changes when renamed) and what its QR holds. */
export async function labels(actor: Actor, locationId: string, spotIds?: string[]) {
  await storeOf(actor.clientId, locationId, undefined, true);
  return shelf(() => spotService.labels(actor.clientId, locationId, spotIds));
}

/* ── racks: what is where ───────────────────────────────────────────────────────────────────────── */

export async function onSpot(actor: Actor, spotId: string) {
  await ownSpot(actor, spotId);
  const r: any = await shelf(() => shelfStockService.onSpot(actor.clientId, spotId));
  const out: any = await inBoutiqueUnits(actor.clientId, r);
  // The shelf's total mixes units (metres and pieces); per unit it means something.
  const byUnit: Record<string, number> = {};
  for (const i of out.items ?? []) byUnit[i.unit] = Math.round(((byUnit[i.unit] ?? 0) + i.quantity) * 100) / 100;
  delete out.total;
  return { ...out, totalByUnit: byUnit };
}
/** A scanned label (camera or scanner), or a typed address: the shelf and what is on it. */
export async function scan(actor: Actor, raw: unknown, locationId?: string) {
  const code = String(raw ?? '').trim();
  if (!code) throw problem('Send the scanned label or the shelf address as code.');
  const spot: any = await shelf(() => spotService.resolve(actor.clientId, code, locationId));
  const id = spot?.id ?? spot?.spot?.id;
  if (!id) throw problem('No shelf has that label or address.', 404);
  return onSpot(actor, id);
}
/** Where is it? By item code, or by a search of name, code or colour. */
export async function whereIs(actor: Actor, itemCode: string, locationId?: string) {
  const v = await variantOf(actor.clientId, itemCode);
  return inBoutiqueUnits(actor.clientId, await shelf(() => shelfStockService.whereIs(actor.clientId, v.id, locationId)));
}
export async function find(actor: Actor, search: unknown, locationId?: string) {
  const r: any = await shelf(() => shelfStockService.find(actor.clientId, search, locationId));
  return inBoutiqueUnits(actor.clientId, r);
}
export async function notShelved(actor: Actor, locationId: string, page: unknown) {
  await storeOf(actor.clientId, locationId, undefined, true);
  return inBoutiqueUnits(actor.clientId, await shelf(() => shelfStockService.notShelved(actor.clientId, locationId, Math.max(1, Number(page) || 1))));
}
export async function spotHistory(actor: Actor, spotId: string) {
  await ownSpot(actor, spotId);
  return inBoutiqueUnits(actor.clientId, await shelf(() => shelfStockService.history(actor.clientId, spotId)));
}

/* ── racks: moving and counting ─────────────────────────────────────────────────────────────────── */

/**
 * Put away (from "not shelved" onto a shelf), move shelf to shelf, or take off a shelf (back to "not shelved").
 * The quantity is in the item's unit. Shelves that already hold the item are listed first by GET /items/{code}/where.
 */
export async function moveOnShelves(actor: Actor, body: any) {
  mustShelve(actor);
  const v = await variantOf(actor.clientId, body?.itemCode);
  const locationId = await storeOf(actor.clientId, body?.locationId);
  const q = baseQty(body?.quantity, v.product.soldBy as SoldBy);
  if (q <= 0) throw problem('The quantity must be more than 0.');
  if (!body?.fromSpotId && !body?.toSpotId) throw problem('Say which shelf it comes from (fromSpotId) or goes to (toSpotId).');
  if (body.fromSpotId && body.fromSpotId === body.toSpotId) throw problem('It is already on that shelf.');
  for (const s of [body.fromSpotId, body.toSpotId]) if (s) await ownSpot(actor, String(s));
  const r = await shelf(() => shelfStockService.move(actor.clientId, null, {
    locationId, variantId: v.id, fromSpotId: body.fromSpotId ?? null, toSpotId: body.toSpotId ?? null, quantity: q,
    note: body.note ? String(body.note).slice(0, 200) : `by ${actor.name}`
  } as any));
  return inBoutiqueUnits(actor.clientId, r);
}
/** Everything on one shelf to another, at once. */
export async function moveWholeShelf(actor: Actor, body: any) {
  mustShelve(actor);
  if (!body?.fromSpotId || !body?.toSpotId || body.fromSpotId === body.toSpotId) throw problem('Give two different shelves: fromSpotId and toSpotId.');
  await ownSpot(actor, String(body.fromSpotId)); await ownSpot(actor, String(body.toSpotId));
  return inBoutiqueUnits(actor.clientId, await shelf(() => shelfStockService.moveAll(actor.clientId, null, String(body.fromSpotId), String(body.toSpotId))));
}
/**
 * Count a shelf: counts per item (in the item's unit), complete: true when the whole shelf was looked at (anything on
 * record and not counted is then 0). Differences become problems to check; no stock changes.
 */
export async function countShelf(actor: Actor, spotId: string, body: any) {
  mustShelve(actor);
  await ownSpot(actor, spotId);
  if (!Array.isArray(body?.counts)) throw problem('Send counts: a list of { itemCode, quantity }.');
  const counts: { variantId: string; counted: number }[] = [];
  for (const c of body.counts) {
    const v = await variantOf(actor.clientId, c?.itemCode);
    const q = baseQty(c?.quantity, v.product.soldBy as SoldBy, 'count');
    if (q < 0) throw problem('A count cannot be below 0.');
    counts.push({ variantId: v.id, counted: q });
  }
  // The boutique counts only its own items. On a shelf it shares with the shop's own pieces, "the whole shelf"
  // would count those as 0 and raise false problems: they are kept at what is recorded.
  if (body.complete === true) {
    const named = new Set(counts.map(c => c.variantId));
    const others = await prisma.spotStock.findMany({ where: { clientId: actor.clientId, spotId, variant: { boutiqueRef: null } }, select: { variantId: true, quantity: true } });
    for (const o of others) if (!named.has(o.variantId)) counts.push({ variantId: o.variantId, counted: o.quantity });
  }
  return inBoutiqueUnits(actor.clientId, await shelf(() => shelfCountService.count(actor.clientId, null, spotId, { counts, complete: body.complete === true })));
}
/** Shelves to count next: least recently counted first (never counted first of all), only shelves that hold stock. */
export async function countQueue(actor: Actor, locationId: string) {
  await storeOf(actor.clientId, locationId, undefined, true);
  const spots = await prisma.storageSpot.findMany({
    where: { clientId: actor.clientId, locationId, active: true, children: { none: {} } },
    select: { id: true, address: true, name: true, lastCountedAt: true, isShopFloor: true },
    orderBy: [{ lastCountedAt: { sort: 'asc', nulls: 'first' } }, { address: 'asc' }], take: 200
  });
  return spots;
}

/* ── problems ───────────────────────────────────────────────────────────────────────────────────── */

export async function problems(actor: Actor, q: { status?: unknown; locationId?: unknown; page?: unknown }) {
  const status = q.status ? String(q.status).toUpperCase() : undefined;
  if (status && !['OPEN', 'RESOLVED', 'ALL'].includes(status)) throw problem('status is OPEN, RESOLVED or ALL.');
  return inBoutiqueUnits(actor.clientId, await shelf(() => shelfIssueService.list(actor.clientId, { ...q, status })));
}
export async function fixProblem(actor: Actor, issueId: string, body: any) {
  mustSetUp(actor);
  const i = await prisma.shelfIssue.findFirst({ where: { id: issueId, clientId: actor.clientId }, select: { id: true } });
  if (!i) throw problem('That problem is not in this shop.', 404);
  return shelf(() => shelfIssueService.resolve(actor.clientId, issueId, null, body?.note ? `${String(body.note).slice(0, 480)} (${actor.name})` : `fixed by ${actor.name}`));
}
