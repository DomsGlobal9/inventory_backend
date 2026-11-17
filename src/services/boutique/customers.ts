/**
 * The boutique app's (CRM-B) customers on ScaleEzy's one customer list (17 Nov 2026; agreed with the CRM chat).
 *
 * The owner, 17 Nov: measurements and stitching are the boutique's alone -- "boutique means CRM-B only" -- and CRM is
 * the shop's own customer list. So ScaleEzy keeps only the PERSON, for the till, the online shop and CRM to know the
 * same customer. No measurements, no stitching orders and no boutique link ever come here; CRM shows these people as
 * the shop's ordinary customers.
 *   - a boutique person is linked to the Inventory customer holding their phone number (one customer per number, as
 *     everywhere in Inventory), or a new customer is made. An existing customer's name, phone and email are never
 *     changed by CRM-B; blanks are filled only when the names agree;
 *   - several boutique people can sit on one customer (a family phone), each its own row, never merged; `nameMatches`
 *     says whether it is that customer or someone else on their number;
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
    removed: row.removed, removedReason: row.removedReason
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
