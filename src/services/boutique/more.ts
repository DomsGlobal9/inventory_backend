/**
 * The rest of what CRM-B's inventory does, so it can drop its own (16 Nov 2026, "CRM-B Inventory Functionality
 * Checklist"). Everything here reads and writes the same stock as the shop, through the same doorway; none of it
 * changes how a retail shop's own screens, till, online shop or Shopify behave -- it is only reachable with a
 * boutique pass, and only ever sees the boutique's own items (a colour with an item code).
 *
 *  - items: look up many at once, the next free code, counts by category, alerts
 *  - movements: every movement on the boutique's items, filtered and paged; and the changes made in ScaleEzy
 *    (till, online shop, Shopify, the owner) since a cursor, so CRM-B's alerts and reports know of them
 *  - places: list with kind and default, rename, switch off, what is at one
 *  - holds: many lines for one order in one call, release everything an order holds, check availability
 *  - photos: signed upload links, so the bytes go straight to storage
 */
import { randomBytes } from 'node:crypto';
import { Prisma, InventoryReason } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { supabase } from '../../lib/supabase';
import { factorOf, formatQty, type SoldBy } from '../../lib/units';
import {
  type Actor, type Db, problem, itemView, itemWhere, listItems, baseQty, variantOf, storeOf, reserve, release, movementView
} from './index';

const wholeAtLeast1 = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? n : null; };
const pageOf = (q: { page?: unknown; limit?: unknown }, dflt = 20, max = 100) => {
  const limit = Math.min(max, wholeAtLeast1(q.limit) ?? dflt);
  return { page: wholeAtLeast1(q.page) ?? 1, limit };
};

/* ── items ──────────────────────────────────────────────────────────────────────────────────────── */

/** Several items by code in one call (the order screen, the workroom, the AI preview). At most 200; unknown codes are listed. */
export async function lookupItems(actor: Actor, raw: unknown) {
  if (!Array.isArray(raw) || !raw.length) throw problem('Send itemCodes: a list of item codes.');
  if (raw.length > 200) throw problem('Look up at most 200 items at once.');
  const codes = [...new Set(raw.map(c => String(c ?? '').trim()).filter(Boolean))];
  const found = await listItems(actor, { itemCodes: codes, limit: 100, page: 1 });
  const items = found.items.slice();
  // listItems pages at 100; a second page for 101..200 codes.
  if (found.totalPages > 1) items.push(...(await listItems(actor, { itemCodes: codes, limit: 100, page: 2 })).items);
  const have = new Set(items.map(i => i.itemCode));
  return { items, notFound: codes.filter(c => !have.has(c)) };
}

/**
 * The next free item code for a prefix: PRD -> PRD-0001, PRD-0002... It is not reserved: send the new item with
 * ifNew: true, and if two people took the same code, the second is told (409) and asks again.
 */
export async function nextCode(actor: Actor, rawPrefix: unknown) {
  const prefix = String(rawPrefix ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(prefix)) throw problem('The prefix is 1 to 10 letters or digits, for example PRD or FG.');
  // Up to 9 digits: a code like PRD-20261116123456 is not a counter and must not overflow the sum.
  const pattern = `^${prefix}-([0-9]{1,9})$`;
  const [row] = await prisma.$queryRaw<{ n: number | null }[]>`
    SELECT MAX(CAST(substring(boutique_ref from ${pattern}) AS INTEGER)) AS n
    FROM inventory_product_variants WHERE client_id = ${actor.clientId} AND boutique_ref ~ ${pattern}`;
  const next = (row?.n ?? 0) + 1;
  return { prefix, itemCode: `${prefix}-${String(next).padStart(4, '0')}`, number: next };
}

/** Counts for the item list's groups: all, per category, per kind of item, archived, reorder due. */
export async function itemGroups(actor: Actor) {
  const base = await itemWhere(actor, {});
  const [all, archived, byCategory, byType, due, inBin] = await Promise.all([
    prisma.productVariant.count({ where: { ...base, product: { status: { not: 'ARCHIVED' as any }, trashedAt: null } } }),
    prisma.productVariant.count({ where: { ...base, product: { status: 'ARCHIVED' as any, trashedAt: null } } }),
    prisma.$queryRaw<{ category: string | null; n: bigint }[]>`
      SELECT p.boutique_category AS category, COUNT(*) AS n FROM inventory_product_variants v JOIN inventory_products p ON p.id = v.product_id
      WHERE v.client_id = ${actor.clientId} AND v.boutique_ref IS NOT NULL AND p.status <> 'ARCHIVED' AND p.trashed_at IS NULL GROUP BY 1`,
    prisma.$queryRaw<{ item_type: string | null; n: bigint }[]>`
      SELECT p.item_type, COUNT(*) AS n FROM inventory_product_variants v JOIN inventory_products p ON p.id = v.product_id
      WHERE v.client_id = ${actor.clientId} AND v.boutique_ref IS NOT NULL AND p.status <> 'ARCHIVED' AND p.trashed_at IS NULL GROUP BY 1`,
    prisma.productVariant.count({ where: await itemWhere(actor, { reorderDue: '1', status: 'ACTIVE' }) }),
    prisma.productVariant.count({ where: { ...base, product: { trashedAt: { not: null } } } })
  ]);
  return {
    all, archived, inBin, reorderDue: due,
    byCategory: Object.fromEntries(byCategory.map(r => [r.category ?? 'NONE', Number(r.n)])),
    byItemType: Object.fromEntries(byType.map(r => [r.item_type ?? 'NONE', Number(r.n)]))
  };
}

/** Live items that are out of stock or at their reorder level -- what CRM-B tells the owner about. */
export async function alerts(actor: Actor) {
  const where = await itemWhere(actor, { reorderDue: '1', status: 'ACTIVE' });
  const rows = await prisma.productVariant.findMany({ where, include: { product: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 });
  const views = (await listItems(actor, { itemCodes: rows.map(r => r.boutiqueRef!), limit: 100 })).items;
  const more = rows.length > 100 ? (await Promise.all([2, 3, 4, 5].map(p => listItems(actor, { itemCodes: rows.map(r => r.boutiqueRef!), limit: 100, page: p })))).flatMap(r => r.items) : [];
  return [...views, ...more].map((i: any) => ({
    itemCode: i.itemCode, name: i.name, colour: i.colour, unit: i.unit, free: i.free, reorderLevel: i.reorderLevel, minStock: i.minStock,
    alert: i.outOfStock ? 'OUT_OF_STOCK' : 'REORDER_LEVEL', belowMinimum: i.belowMinimum
  }));
}

/* ── movements ──────────────────────────────────────────────────────────────────────────────────── */

const dateOf = (v: unknown, what: string) => {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw problem(`${what} is not a date (use 2026-11-16 or a full ISO time).`);
  return d;
};

/** Every movement on the boutique's items, newest first, filtered by item, order, place, kind, source and dates. */
export async function listMovements(actor: Actor, q: Record<string, unknown>) {
  const { page, limit } = pageOf(q);
  // A bare day (2026-11-16) is that day in India, the same as the reports; "to" then means the whole of that day.
  const bare = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
  const from = bare(q.from) ? new Date(`${q.from}T00:00:00+05:30`) : dateOf(q.from, 'from');
  const toDay = bare(q.to) ? new Date(`${q.to}T00:00:00+05:30`) : dateOf(q.to, 'to');
  if (toDay && Number.isNaN(toDay.getTime())) throw problem('to is not a date (use 2026-11-16 or a full ISO time).');
  if (from && Number.isNaN(from.getTime())) throw problem('from is not a date (use 2026-11-16 or a full ISO time).');
  const toEnd = toDay && bare(q.to) ? new Date(toDay.getTime() + 86_400_000) : toDay;
  const kind = q.kind ? String(q.kind).trim().toUpperCase() : null;
  const source = q.source ? String(q.source).trim().toUpperCase() : null;
  if (source && !['BOUTIQUE', 'SCALEEZY'].includes(source)) throw problem('source is BOUTIQUE or SCALEEZY.');
  const where: Prisma.InventoryTransactionWhereInput = {
    clientId: actor.clientId,
    variant: { boutiqueRef: q.itemCode ? String(q.itemCode) : { not: null } },
    ...(q.orderRef ? { boutiqueOrderRef: String(q.orderRef) } : {}),
    ...(q.locationId ? { locationId: String(q.locationId) } : {}),
    // A boutique word (WASTE) or one of ours (SALE); ours only when it is one, or the database refuses the query.
    AND: [
      ...(kind ? [{ OR: [{ boutiqueKind: kind }, ...((Object.values(InventoryReason) as string[]).includes(kind) ? [{ boutiqueKind: null, reason: kind as InventoryReason }] : [])] }] : []),
      ...(source === 'BOUTIQUE' ? [{ OR: [{ referenceType: 'BOUTIQUE' }, { boutiqueKind: { not: null } }] }]
        : source === 'SCALEEZY' ? [{ boutiqueKind: null, OR: [{ referenceType: null }, { referenceType: { not: 'BOUTIQUE' } }] }] : [])
    ],
    ...(from || toEnd ? { createdAt: { ...(from ? { gte: from } : {}), ...(toEnd ? { lt: toEnd } : {}) } } : {})
  };
  const [rows, total] = await Promise.all([
    prisma.inventoryTransaction.findMany({ where, include: { location: { select: { name: true } }, variant: { select: { boutiqueRef: true, product: { select: { soldBy: true } } } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
    prisma.inventoryTransaction.count({ where })
  ]);
  const totalPages = Math.ceil(total / limit);
  return { movements: rows.map(t => movementView(t, t.variant.boutiqueRef, t.variant.product.soldBy)), page, limit, total, totalPages, hasMore: page < totalPages };
}

/**
 * What changed the boutique's stock in ScaleEzy and not through this API -- a till sale, an online order, Shopify, a
 * return, the owner's own count -- oldest first, after a cursor. CRM-B keeps the last `next` and asks again.
 *
 * Only movements at least SETTLE seconds old are given: a sale's database transaction can take many seconds to
 * commit (a till far from the database), and a row that commits after the cursor moved past its time would be
 * missed for ever. So the list runs a little behind, and never skips.
 */
const SETTLE_SECONDS = 120;
export async function changes(actor: Actor, q: { after?: unknown; limit?: unknown }) {
  const limit = Math.min(500, wholeAtLeast1(q.limit) ?? 100);
  let afterAt: Date | null = null, afterId = '';
  if (q.after) {
    const [at, id] = String(q.after).split('_');
    afterAt = new Date(at);
    afterId = id ?? '';
    if (Number.isNaN(afterAt.getTime())) throw problem('after is the "next" value from the last answer.');
  }
  const settled = new Date(Date.now() - SETTLE_SECONDS * 1000);
  const rows = await prisma.inventoryTransaction.findMany({
    where: {
      clientId: actor.clientId, variant: { boutiqueRef: { not: null } },
      OR: [{ referenceType: null }, { referenceType: { not: 'BOUTIQUE' } }],
      // Not the boutique's own (its purchase-order receipts are marked), and not shelf moves: they change no stock.
      boutiqueKind: null, reason: { not: 'SHELF_MOVE' as any },
      createdAt: { lte: settled, ...(afterAt ? { gte: afterAt } : {}) },
      ...(afterAt ? { NOT: { createdAt: afterAt, id: { lte: afterId } } } : {})
    },
    include: { location: { select: { name: true } }, variant: { select: { boutiqueRef: true, product: { select: { soldBy: true } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit + 1
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    changes: page.map(t => movementView(t, t.variant.boutiqueRef, t.variant.product.soldBy)),
    next: last ? `${last.createdAt.toISOString()}_${last.id}` : (q.after ? String(q.after) : null),
    hasMore: rows.length > limit, settleSeconds: SETTLE_SECONDS
  };
}

/* ── places ─────────────────────────────────────────────────────────────────────────────────────── */

const KIND_BY_PREFIX: Record<string, string> = {
  MAI: 'MAIN_STORE', SHO: 'SHOWROOM', WAR: 'WAREHOUSE', WOR: 'WORKSHOP', CUT: 'CUTTING_UNIT', EMB: 'EMBROIDERY_UNIT', TAI: 'TAILOR', FIN: 'FINISHING_UNIT'
};
const kindOf = (l: { code: string; type: string }) => KIND_BY_PREFIX[l.code.slice(0, 3)] ?? (l.type === 'STORE' ? 'MAIN_STORE' : 'WAREHOUSE');

/** The shop's default place: the first active one. Stock with no place named goes there. */
async function defaultPlace(clientId: string, db: Db | typeof prisma = prisma) {
  return db.stockLocation.findFirst({ where: { clientId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
}

export async function listStores(actor: Actor, q: { all?: unknown }) {
  const [rows, dflt] = await Promise.all([
    prisma.stockLocation.findMany({ where: { clientId: actor.clientId, ...(q.all === '1' || q.all === 'true' ? {} : { active: true }) }, orderBy: { createdAt: 'asc' } }),
    defaultPlace(actor.clientId)
  ]);
  return rows.map(l => ({ id: l.id, name: l.name, code: l.code, type: l.type, kind: kindOf(l), active: l.active, isDefault: l.id === dflt?.id }));
}

/** Rename a place, or switch it off / on. Names stay unique; a place with stock, or the default one, cannot be switched off. */
export async function updateStore(tx: Db, actor: Actor, id: string, input: { name?: unknown; active?: unknown }) {
  if (!actor.can.includes('stock:write')) throw problem('This person may not change places.', 403);
  const l = await tx.stockLocation.findFirst({ where: { id, clientId: actor.clientId } });
  if (!l) throw problem('That place is not in this shop.', 404);
  const data: Prisma.StockLocationUpdateInput = {};
  if (input.name != null) {
    const name = String(input.name).trim().slice(0, 120);
    if (!name) throw problem('Give the place a name.');
    const same = await tx.stockLocation.findFirst({ where: { clientId: actor.clientId, id: { not: id }, name: { equals: name, mode: 'insensitive' } } });
    if (same) throw problem(`There is already a place called ${same.name}.`, 409);
    data.name = name;
  }
  if (input.active != null) {
    if (typeof input.active !== 'boolean') throw problem('active is true or false.');
    if (input.active === false && l.active) await refuseSwitchOff(tx, actor.clientId, l);
    data.active = input.active;
  }
  const u = await tx.stockLocation.update({ where: { id }, data });
  return { status: 200, answer: { success: true, data: { id: u.id, name: u.name, kind: kindOf(u), active: u.active } } };
}

async function refuseSwitchOff(tx: Db, clientId: string, l: { id: string; name: string }) {
  const dflt = await defaultPlace(clientId, tx);
  if (dflt?.id === l.id) throw problem(`${l.name} is the default place, so it cannot be removed. Make another place the first one first.`, 409);
  const stock = await tx.inventoryStock.aggregate({ where: { locationId: l.id }, _sum: { quantity: true, reservedQty: true } });
  if ((stock._sum.quantity ?? 0) !== 0 || (stock._sum.reservedQty ?? 0) !== 0) throw problem(`${l.name} still holds stock. Move it to another place first.`, 409);
}

/** "Remove" a place: it is switched off, never deleted -- its history stays readable. Same refusals as switching off. */
export async function removeStore(tx: Db, actor: Actor, id: string) {
  if (!actor.can.includes('stock:write')) throw problem('This person may not remove places.', 403);
  const l = await tx.stockLocation.findFirst({ where: { id, clientId: actor.clientId } });
  if (!l) throw problem('That place is not in this shop.', 404);
  if (l.active) {
    await refuseSwitchOff(tx, actor.clientId, l);
    await tx.stockLocation.update({ where: { id }, data: { active: false } });
  }
  return { status: 200, answer: { success: true, data: { id, removed: true } } };
}

/** What is at one place: every item with stock there, a page at a time. */
export async function itemsAt(actor: Actor, locationId: string, q: { page?: unknown; limit?: unknown }) {
  const l = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId: actor.clientId } });
  if (!l) throw problem('That place is not in this shop.', 404);
  return listItems(actor, { ...q, locationId });
}

/* ── holds for an order ─────────────────────────────────────────────────────────────────────────── */

type Line = { itemCode?: unknown; quantity?: unknown; locationId?: unknown };
const linesOf = (raw: unknown, max = 100) => {
  if (!Array.isArray(raw) || !raw.length) throw problem('Send lines: a list of { itemCode, quantity }.');
  if (raw.length > max) throw problem(`At most ${max} lines at once.`);
  return raw as Line[];
};

/**
 * Hold every line of an order in one call (an order confirmed). allOrNothing: true refuses the whole call (nothing
 * held) when any line is short; otherwise each line holds what is free and says what is short -- the order is still
 * saved, as CRM-B does today.
 */
export async function holdOrder(tx: Db, actor: Actor, input: { orderRef?: unknown; lines?: unknown; allOrNothing?: unknown }) {
  const lines = linesOf(input.lines);
  const all = input.allOrNothing === true;
  const results = [];
  for (const [i, l] of lines.entries()) {
    try {
      const r = await reserve(tx, actor, { itemCode: l.itemCode, quantity: l.quantity, orderRef: input.orderRef, locationId: l.locationId, allowShort: !all });
      results.push({ line: i + 1, ...(r.answer as any).data });
    } catch (e: any) {
      throw problem(`Line ${i + 1} (${String(l.itemCode ?? '')}): ${e.message}${all ? ' Nothing was held.' : ''}`, e.statusCode ?? 400);
    }
  }
  const short = results.filter(r => r.short > 0);
  return { status: 201, answer: { success: true, data: { orderRef: String(input.orderRef ?? '').trim(), lines: results, fullyHeld: short.length === 0, shortLines: short.length } } };
}

/** Let go of everything an order still holds (the last garment delivered, or the order cancelled). */
export async function releaseOrder(tx: Db, actor: Actor, input: { orderRef?: unknown }) {
  if (!actor.can.includes('stitching:issue')) throw problem('This person may not release held cloth.', 403);
  const orderRef = String(input.orderRef ?? '').trim();
  if (!orderRef) throw problem('Say which order.');
  const holds = await tx.boutiqueReservation.findMany({ where: { clientId: actor.clientId, orderRef, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  const released = [];
  for (const h of holds) released.push((await release(tx, actor, { reservationId: h.id }) as any).answer.data);
  return { status: 200, answer: { success: true, data: { orderRef, released: released.length, holds: released } } };
}

/** Is there enough? Each line against free stock (the same item on two lines is added up), and what is short. */
export async function availability(actor: Actor, input: { lines?: unknown }) {
  const lines = linesOf(input.lines, 200);
  const want = new Map<string, { itemCode: string; locationId: string | null; base: number; soldBy: SoldBy; name: string }>();
  for (const l of lines) {
    const v = await variantOf(actor.clientId, l.itemCode);
    const soldBy = v.product.soldBy as SoldBy;
    const q = baseQty(l.quantity, soldBy);
    if (q <= 0) throw problem(`${v.boutiqueRef}: the quantity must be more than 0.`);
    const loc = l.locationId ? await storeOf(actor.clientId, l.locationId) : null;
    const key = `${v.id}|${loc ?? ''}`;
    const w = want.get(key);
    if (w) w.base += q; else want.set(key, { itemCode: v.boutiqueRef!, locationId: loc, base: q, soldBy, name: v.product.title });
  }
  const out = [];
  for (const [key, w] of want) {
    const variantId = key.split('|')[0];
    const s = await prisma.inventoryStock.aggregate({ where: { variantId, ...(w.locationId ? { locationId: w.locationId } : {}) }, _sum: { quantity: true, reservedQty: true } });
    const free = Math.max(0, (s._sum.quantity ?? 0) - (s._sum.reservedQty ?? 0));
    const f = factorOf(w.soldBy);
    out.push({ itemCode: w.itemCode, name: w.name, locationId: w.locationId, needed: w.base / f, free: free / f, short: Math.max(0, w.base - free) / f, freeText: formatQty(free, w.soldBy) });
  }
  return { lines: out, enough: out.every(l => l.short === 0) };
}

/* ── photos ─────────────────────────────────────────────────────────────────────────────────────── */

const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Upload links for up to 10 photos, 10 MB each, before the item is saved (camera allowed). CRM-B PUTs each file's
 * bytes to its uploadUrl, then sends the publicUrl in the item's imageUrls (the first is the cover).
 */
export async function photoUploads(actor: Actor, input: { files?: unknown }) {
  if (!actor.can.includes('products:write')) throw problem('This person may not add photos.', 403);
  const files = input.files;
  if (!Array.isArray(files) || !files.length) throw problem('Send files: a list of { name, contentType, size }.');
  if (files.length > 10) throw problem('At most 10 photos at once.');
  const month = new Date().toISOString().slice(0, 7);
  const out = [];
  for (const [i, f] of (files as any[]).entries()) {
    const type = String(f?.contentType ?? '').toLowerCase();
    if (!PHOTO_TYPES[type]) throw problem(`Photo ${i + 1}: use a JPEG, PNG or WebP picture.`);
    const size = Number(f?.size);
    if (!Number.isFinite(size) || size <= 0) throw problem(`Photo ${i + 1}: give its size in bytes.`);
    if (size > MAX_PHOTO_BYTES) throw problem(`Photo ${i + 1} is over 10 MB. Make it smaller and try again.`);
    const safe = String(f?.name ?? 'photo').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'photo';
    const path = `${actor.clientId}/boutique/${month}/${Date.now()}-${randomBytes(4).toString('hex')}-${safe}.${PHOTO_TYPES[type]}`;
    const { data, error } = await supabase.storage.from('inventory-images').createSignedUploadUrl(path);
    if (error || !data) {
      console.error('[boutique photos] could not prepare upload:', error?.message || 'no answer from storage');
      throw problem('The photos cannot be uploaded just now. Please try again in a minute.', 502);
    }
    const { data: pub } = supabase.storage.from('inventory-images').getPublicUrl(path);
    out.push({ name: f?.name ?? null, uploadUrl: data.signedUrl, token: data.token, contentType: type, publicUrl: pub.publicUrl });
  }
  return { files: out, maxBytes: MAX_PHOTO_BYTES };
}

export { itemView };

/**
 * Before an item is saved with photos from our own storage: each must be this shop's, really uploaded, and at most
 * 10 MB. The upload link cannot cap the size (storage takes whatever is sent), so an oversized photo is deleted
 * here and the save refused. Links to anywhere else (the boutique's own CDN) are left alone.
 */
export async function checkOwnPhotos(clientId: string, urls: unknown) {
  if (!Array.isArray(urls)) return;
  const base = supabase.storage.from('inventory-images').getPublicUrl('').data.publicUrl.replace(/\/$/, '');
  for (const [i, raw] of urls.entries()) {
    const url = String(raw ?? '');
    if (!url.startsWith(`${base}/`)) continue;
    let path = '';
    try { path = decodeURIComponent(url.slice(base.length + 1).split(/[?#]/)[0]); } catch { /* a broken %-sequence: refused below */ }
    // "<shop>/../<other shop>/x.jpg" would pass a plain prefix check: only plain names inside this shop's folder.
    if (!path || path.split('/').some(seg => seg === '..' || seg === '.' || seg === '') || path.includes('\\') || !/^[A-Za-z0-9._\-/]+$/.test(path)
      || !path.startsWith(`${clientId}/`)) throw problem(`Photo ${i + 1} belongs to another shop. Upload it again for this one.`, 403);
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (!head || head.status === 404 || head.status === 400) throw problem(`Photo ${i + 1} was not uploaded. Upload it again, then save the item.`);
    const size = Number(head.headers.get('content-length') ?? 0);
    if (size > MAX_PHOTO_BYTES) {
      await supabase.storage.from('inventory-images').remove([path]).catch(() => undefined);
      throw problem(`Photo ${i + 1} is over 10 MB, so it was removed. Make it smaller and upload it again.`);
    }
  }
}
