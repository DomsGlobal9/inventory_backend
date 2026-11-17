/**
 * The boutique app's (CRM-B) customers in ScaleEzy (17 Nov 2026; agreed with the CRM chat, owner: "one person, one
 * record").
 *
 * CRM-B keeps its customers' measurements and stitching orders. What ScaleEzy needs is one customer list for the
 * till, the online shop and CRM, so:
 *   - a boutique person is linked to the Inventory customer holding their phone number (one customer per number, as
 *     everywhere in Inventory), or a new customer is made. An existing customer's name, phone and email are never
 *     changed by CRM-B; blanks are filled only when the names agree;
 *   - several boutique people can sit on one customer (a family phone). Each keeps its own row and snapshot, never
 *     merged; `nameMatches` says whether it is that customer or someone else on their number;
 *   - CRM-B sends a read-only snapshot (measurement sets + a small stitching summary) whenever it changes; CRM shows it
 *     from the module feed (customer_boutique_profile.*), with "Edit in the boutique app";
 *   - when Inventory removes the customer, a database trigger wipes every boutique person on them (no personal data
 *     kept) and marks them removed: CRM wipes its copy from the feed, CRM-B from GET /customers/removed.
 * Nobody is offered WhatsApp from here; consent stays Inventory's.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { generateSequentialCode } from '../../utils/codeGenerator';
import { counterCustomer } from '../customer.service';
import { dayOfYear } from '../customer-import';
import { problem, type Actor, type Db } from './index';

const ID = /^[A-Za-z0-9._:-]{1,100}$/;
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
export const BULK_MAX = 200;

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();
/** Names compared as people write them: case, spaces and dots ignored ("Lakshmi  K." = "lakshmi k"). */
export const sameName = (a: unknown, b: unknown) => {
  const n = (x: unknown) => text(x).toLowerCase().replace(/[\s.]/g, '');
  return n(a) !== '' && n(a) === n(b);
};
const mustWrite = (actor: Actor) => { if (!actor.can.includes('customers:write')) throw problem('This person may not add or change customers.', 403); };

export type BoutiqueCustomerIn = {
  boutiqueCustomerId?: unknown; name?: unknown; phone?: unknown; email?: unknown;
  birthday?: unknown; anniversary?: unknown; address?: unknown;
};
type Clean = { bid: string; name: string; phone: string | null; email: string | null; birthday: string | null; anniversary: string | null; address: string | null };

/** One person's details checked on their own; the reason in words when they cannot be taken. */
export function readPerson(input: BoutiqueCustomerIn): { ok: true; c: Clean } | { ok: false; say: string } {
  const bid = text(input?.boutiqueCustomerId);
  if (!ID.test(bid)) return { ok: false, say: 'boutiqueCustomerId is the boutique\'s own id for this person: 1 to 100 letters, numbers, dots, dashes, colons or underscores.' };
  const name = text(input.name);
  if (!name) return { ok: false, say: 'Give the customer\'s name.' };
  if (name.length > 120) return { ok: false, say: 'The name is longer than 120 letters.' };
  let phone: string | null = null;
  if (text(input.phone)) {
    const p = normalisePhone(text(input.phone));
    if (!p.ok) return { ok: false, say: `Phone ${text(input.phone)}: ${p.reason}` };
    phone = p.value;
  }
  const email = text(input.email) || null;
  if (email && (!EMAIL.test(email) || email.length > 200)) return { ok: false, say: `Email ${email.slice(0, 60)} is not an email address.` };
  const b = dayOfYear(input.birthday, 'Birthday');
  if (!b.ok) return { ok: false, say: b.say };
  const a = dayOfYear(input.anniversary, 'Anniversary');
  if (!a.ok) return { ok: false, say: a.say };
  const address = text(input.address) || null;
  if (address && address.length > 500) return { ok: false, say: 'The address is longer than 500 letters.' };
  return { ok: true, c: { bid, name, phone, email, birthday: b.value, anniversary: a.value, address } };
}

/** The Inventory customer for this person: by number (made when nobody has it), or by the boutique id when no number. */
async function customerFor(tx: Db, clientId: string, c: Clean, current: { customerId: string | null } | null) {
  if (c.phone) {
    const before = await tx.customer.findFirst({ where: { clientId, phone: c.phone, deletedAt: null }, select: { id: true } });
    const who = await counterCustomer(tx as any, clientId, { phone: c.phone, name: c.name, email: c.email });
    return { id: who.id, made: !before };
  }
  // No number now, but already linked: they stay where they are (a number left out is not a reason to move them).
  if (current?.customerId) {
    const still = await tx.customer.findFirst({ where: { id: current.customerId, clientId, deletedAt: null }, select: { id: true } });
    if (still) return { id: still.id, made: false };
  }
  const key = `boutique:${c.bid}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-ext:${clientId}:${key}`}))`;
  const found = await tx.customer.findFirst({ where: { clientId, externalCustomerId: key, deletedAt: null }, select: { id: true } });
  if (found) return { id: found.id, made: false };
  const customerCode = await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any);
  const made = await tx.customer.create({ data: { clientId, customerCode, name: c.name, externalCustomerId: key, status: 'ACTIVE', whatsappOffers: false } });
  return { id: made.id, made: true };
}

/** Link (or move) one boutique person. Returns where they are now. */
async function linkOne(tx: Db, clientId: string, c: Clean) {
  // One boutique person at a time: the same person sent twice at once waits here and then updates, never a clash.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique-person:${clientId}:${c.bid}`}))`;
  const current = await tx.customerBoutiqueProfile.findUnique({ where: { clientId_boutiqueCustomerId: { clientId, boutiqueCustomerId: c.bid } } });
  const target = await customerFor(tx, clientId, c, current);
  const cust = await tx.customer.findUniqueOrThrow({ where: { id: target.id }, select: { id: true, name: true, email: true, birthday: true, anniversary: true, billingAddress: true } });
  const nameMatches = target.made || sameName(c.name, cust.name);
  // Blanks are filled only on this person's own record: Priya's email never lands on Lakshmi's.
  if (nameMatches) {
    const fill: Prisma.CustomerUpdateInput = {};
    if (!cust.email && c.email) fill.email = c.email;
    if (!cust.birthday && c.birthday) fill.birthday = c.birthday;
    if (!cust.anniversary && c.anniversary) fill.anniversary = c.anniversary;
    if (!cust.billingAddress && c.address) fill.billingAddress = c.address;
    if (Object.keys(fill).length) await tx.customer.update({ where: { id: cust.id }, data: fill });
  }
  const data = { customerId: cust.id, boutiqueName: c.name, nameMatches, removed: false, removedReason: null, removedAt: null };
  const row = current
    ? await tx.customerBoutiqueProfile.update({ where: { id: current.id }, data })
    : await tx.customerBoutiqueProfile.create({ data: { clientId, boutiqueCustomerId: c.bid, ...data } });
  return {
    boutiqueCustomerId: c.bid, inventoryCustomerId: cust.id, nameMatches,
    matched: target.made ? 'NEW' : c.phone ? 'BY_PHONE' : 'BY_BOUTIQUE_ID',
    moved: !!current?.customerId && current.customerId !== cust.id,
    relinked: !!current?.removed, profileId: row.id
  };
}

export async function link(tx: Db, actor: Actor, input: BoutiqueCustomerIn) {
  mustWrite(actor);
  const r = readPerson(input);
  if (!r.ok) throw problem(r.say);
  const out = await linkOne(tx, actor.clientId, r.c);
  return { status: out.matched === 'NEW' ? 201 : 200, answer: { success: true, data: out } };
}

/** Up to 200 at once (the boutique's first load). Rows that cannot be taken are named; the rest are linked. */
export async function linkMany(tx: Db, actor: Actor, body: { customers?: unknown }) {
  mustWrite(actor);
  const list = body?.customers;
  if (!Array.isArray(list) || !list.length) throw problem('Send customers: a list of 1 to 200 people.');
  if (list.length > BULK_MAX) throw problem(`Up to ${BULK_MAX} customers at a time; send the rest in the next call.`);
  const seen = new Set<string>();
  const results: any[] = [];
  for (const [i, item] of list.entries()) {
    const r = readPerson(item as BoutiqueCustomerIn);
    if (!r.ok) { results.push({ index: i, boutiqueCustomerId: text((item as any)?.boutiqueCustomerId) || null, ok: false, error: r.say }); continue; }
    if (seen.has(r.c.bid)) { results.push({ index: i, boutiqueCustomerId: r.c.bid, ok: false, error: 'This boutiqueCustomerId is in the list twice; it was taken once.' }); continue; }
    seen.add(r.c.bid);
    results.push({ index: i, ok: true, ...(await linkOne(tx, actor.clientId, r.c)) });
  }
  return { status: 200, answer: { success: true, data: { linked: results.filter(r => r.ok).length, refused: results.filter(r => !r.ok).length, results } } };
}

/* ── the snapshot ───────────────────────────────────────────────────────────────────────────────── */

const GARMENTS = ['Blouse', 'Salwar', 'Lehenga', 'Kurti', 'Other'];
const STATUSES = ['BOOKED', 'IN_PROGRESS', 'TRIAL', 'READY', 'DELIVERED', 'CANCELLED'];
const OPEN = new Set(['BOOKED', 'IN_PROGRESS', 'TRIAL', 'READY']);

function when(v: unknown, what: string, required = false): string | null {
  if (v === null || v === undefined || v === '') { if (required) throw problem(`${what} is needed (an ISO date and time).`); return null; }
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw problem(`${what} is not a date and time (send ISO, like 2026-11-22T10:30:00+05:30).`);
  return d.toISOString();
}
function words(v: unknown, what: string, max: number, required = false): string | null {
  const t = v === null || v === undefined ? '' : String(v).trim();
  if (!t) { if (required) throw problem(`${what} is needed.`); return null; }
  if (t.length > max) throw problem(`${what} is longer than ${max} letters.`);
  return t;
}
function money(v: unknown, what: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e8) throw problem(`${what} is not an amount in rupees.`);
  return Math.round(n * 100) / 100;
}

/** The snapshot made safe, exactly in the shape CRM reads; refused whole (never half) when anything is off. */
export function cleanSnapshot(raw: any, bid: string, inventoryCustomerId: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw problem('Send snapshot: an object.');
  const size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  if (size > MAX_SNAPSHOT_BYTES) throw problem(`The snapshot is ${Math.ceil(size / 1024)} KB; up to 64 KB is kept. Send fewer old orders or measurement sets.`);
  const editUrl = words(raw.editUrl, 'editUrl', 500, true)!;
  if (!/^https:\/\/[^\s]+$/.test(editUrl)) throw problem('editUrl must be an https link to this customer in the boutique app.');
  const sets = Array.isArray(raw.measurementSets) ? raw.measurementSets : [];
  if (sets.length > 50) throw problem('Up to 50 measurement sets are kept.');
  const measurementSets = sets.map((s: any, i: number) => {
    const at = `measurementSets[${i}]`;
    if (!s || typeof s !== 'object') throw problem(`${at} is not a measurement set.`);
    const garment = words(s.garment, `${at}.garment`, 20, true)!;
    if (!GARMENTS.includes(garment)) throw problem(`${at}.garment is one of ${GARMENTS.join(', ')}.`);
    const unit = String(s.unit ?? '');
    if (unit !== 'in' && unit !== 'cm') throw problem(`${at}.unit is "in" or "cm".`);
    const values = Array.isArray(s.values) ? s.values : [];
    if (values.length > 100) throw problem(`${at} has more than 100 values.`);
    return {
      id: words(s.id, `${at}.id`, 100, true), name: words(s.name, `${at}.name`, 120, true), garment,
      takenAt: when(s.takenAt, `${at}.takenAt`, true), takenBy: words(s.takenBy, `${at}.takenBy`, 120), unit,
      values: values.map((v: any, j: number) => ({ label: words(v?.label, `${at}.values[${j}].label`, 60, true), value: words(v?.value, `${at}.values[${j}].value`, 30, true) })),
      note: words(s.note, `${at}.note`, 500)
    };
  }).sort((a: any, b: any) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : 0));
  const setIds = new Set(measurementSets.map((s: any) => s.id));
  if (setIds.size !== measurementSets.length) throw problem('Two measurement sets have the same id.');
  const list = Array.isArray(raw.orders) ? raw.orders : [];
  if (list.length > 100) throw problem('Up to 100 orders are kept (every open one and the last 3 closed).');
  const orders = list.map((o: any, i: number) => {
    const at = `orders[${i}]`;
    if (!o || typeof o !== 'object') throw problem(`${at} is not an order.`);
    const status = String(o.status ?? '');
    if (!STATUSES.includes(status)) throw problem(`${at}.status is one of ${STATUSES.join(', ')}.`);
    const msId = o.measurementSetId === null || o.measurementSetId === undefined || o.measurementSetId === '' ? null : String(o.measurementSetId);
    if (msId && !setIds.has(msId)) throw problem(`${at}.measurementSetId names a measurement set that is not in this snapshot.`);
    return {
      id: words(o.id, `${at}.id`, 100, true), number: words(o.number, `${at}.number`, 40, true), title: words(o.title, `${at}.title`, 120, true),
      measurementSetId: msId, status, statusWords: words(o.statusWords, `${at}.statusWords`, 60),
      bookedAt: when(o.bookedAt, `${at}.bookedAt`, true), trialAt: when(o.trialAt, `${at}.trialAt`), dueAt: when(o.dueAt, `${at}.dueAt`),
      readyAt: when(o.readyAt, `${at}.readyAt`), deliveredAt: when(o.deliveredAt, `${at}.deliveredAt`),
      total: money(o.total, `${at}.total`), advance: money(o.advance, `${at}.advance`), balance: money(o.balance, `${at}.balance`),
      storeName: words(o.storeName, `${at}.storeName`, 120), staffName: words(o.staffName, `${at}.staffName`, 120)
    };
  });
  if (new Set(orders.map((o: any) => o.id)).size !== orders.length) throw problem('Two orders have the same id.');
  const closed = orders.filter((o: any) => !OPEN.has(o.status));
  if (closed.length > 3) throw problem('Send every open order and only the last 3 closed ones.');
  const openOrders = orders.filter((o: any) => OPEN.has(o.status)).length;
  const lastOrderAt = when(raw.lastOrderAt, 'lastOrderAt');
  return {
    boutiqueCustomerId: bid, inventoryCustomerId, snapshotAt: when(raw.snapshotAt, 'snapshotAt', true), editUrl,
    lastOrderAt, openOrders, measurementSets, orders
  };
}

/** The snapshot for one linked boutique person. An older snapshot than the one kept is ignored (answered, not kept). */
export async function putProfile(tx: Db, actor: Actor, bidRaw: unknown, body: { snapshot?: unknown }) {
  mustWrite(actor);
  const bid = text(bidRaw);
  if (!ID.test(bid)) throw problem('That is not a boutiqueCustomerId.');
  const row = await tx.customerBoutiqueProfile.findUnique({ where: { clientId_boutiqueCustomerId: { clientId: actor.clientId, boutiqueCustomerId: bid } } });
  if (!row || row.removed || !row.customerId) throw problem('This person is not linked. Send them to POST /customers first.', 404);
  const snap = cleanSnapshot(body?.snapshot, bid, row.customerId);
  const at = new Date(snap.snapshotAt!);
  if (row.snapshotAt && at < row.snapshotAt) {
    return { status: 200, answer: { success: true, data: { boutiqueCustomerId: bid, kept: false, reason: 'A newer snapshot is already kept.', keptSnapshotAt: row.snapshotAt.toISOString() } } };
  }
  await tx.customerBoutiqueProfile.update({ where: { id: row.id }, data: { snapshot: snap as any, snapshotAt: at } });
  return { status: 200, answer: { success: true, data: { boutiqueCustomerId: bid, inventoryCustomerId: row.customerId, kept: true } } };
}

/** The boutique no longer has this person: their row keeps nothing personal, and CRM wipes its copy. */
export async function unlink(tx: Db, actor: Actor, bidRaw: unknown) {
  mustWrite(actor);
  const bid = text(bidRaw);
  if (!ID.test(bid)) throw problem('That is not a boutiqueCustomerId.');
  const row = await tx.customerBoutiqueProfile.findUnique({ where: { clientId_boutiqueCustomerId: { clientId: actor.clientId, boutiqueCustomerId: bid } } });
  if (!row) throw problem('This person is not linked.', 404);
  if (!row.removed) await tx.customerBoutiqueProfile.update({ where: { id: row.id }, data: { removed: true, removedReason: 'UNLINKED', removedAt: new Date() } });
  return { status: 200, answer: { success: true, data: { boutiqueCustomerId: bid, removed: true } } };
}

/** One linked person, as Inventory holds them (for the boutique to check). */
export async function getOne(actor: Actor, bidRaw: unknown) {
  const bid = text(bidRaw);
  const row = await prisma.customerBoutiqueProfile.findUnique({ where: { clientId_boutiqueCustomerId: { clientId: actor.clientId, boutiqueCustomerId: bid } } });
  if (!row) throw problem('This person is not linked.', 404);
  return {
    boutiqueCustomerId: row.boutiqueCustomerId, inventoryCustomerId: row.customerId, nameMatches: row.nameMatches,
    removed: row.removed, removedReason: row.removedReason, snapshotAt: row.snapshotAt?.toISOString() ?? null
  };
}

/**
 * The people Inventory removed (the customer was deleted or erased), oldest first, for the boutique to wipe its own
 * copy: ids only. `after` is the `next` value from the last answer.
 */
export async function removedSince(actor: Actor, q: { after?: unknown; limit?: unknown }) {
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
  let afterAt: Date | null = null, afterId = '';
  if (q.after) {
    const [at, id] = String(q.after).split('_');
    afterAt = new Date(at); afterId = id ?? '';
    if (Number.isNaN(afterAt.getTime())) throw problem('after is the "next" value from the last answer.');
  }
  const rows = await prisma.customerBoutiqueProfile.findMany({
    where: {
      clientId: actor.clientId, removed: true, removedReason: 'CUSTOMER_REMOVED',
      ...(afterAt ? { OR: [{ removedAt: { gt: afterAt } }, { removedAt: afterAt, id: { gt: afterId } }] } : {})
    },
    orderBy: [{ removedAt: 'asc' }, { id: 'asc' }], take: limit + 1, select: { id: true, boutiqueCustomerId: true, removedAt: true }
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    removed: page.map(r => ({ boutiqueCustomerId: r.boutiqueCustomerId, removedAt: r.removedAt!.toISOString() })),
    next: last ? `${last.removedAt!.toISOString()}_${last.id}` : (q.after ? String(q.after) : null),
    hasMore: rows.length > limit
  };
}
