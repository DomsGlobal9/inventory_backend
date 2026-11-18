/**
 * Customer groups owned by ScaleEzy CRM (18 Nov 2026, the owner: "customer grps also should in crm only").
 *
 * CRM is the source of truth for a shop's groups: names, the two quiet rules, and who is in each. Inventory
 * keeps a READ-ONLY copy in the places it has always read them -- customer_groups (names and rules) and
 * customers.tags (membership) -- so the till's prices, offers, the POS badge, door check-in and Shopify
 * discounts keep working without ever calling CRM on a bill.
 *
 * CRM writes the copy, never Inventory's own screens:
 *   - put():   the whole shop at once { version, groups, members }. Idempotent. Customers not listed end
 *              up in no group; groups not listed are removed.
 *   - patch(): one customer's groups { version, groups }, so a change shows at the till within seconds.
 * version is CRM's own increasing number. Each write must carry a bigger one than the last that was
 * applied, so a push that arrives late (a retry, two in flight) can never put back an older state.
 *
 * Groups are CRM's for every shop (the owner, 18 Nov 2026): Inventory's group routes refuse changes
 * (refuseIfGroupsInCrm), customers' groups cannot be edited here, and auto-join is CRM's (a copy carries
 * no rule, and Inventory's own auto-join job no longer runs).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { MAX_CUSTOMER_TAGS, MAX_TAG_LENGTH } from '../offers/rules';

/** The same "vip" = "VIP" rule as customer-groups' keyOf (kept here so neither module imports the other). */
const keyOf = (name: string) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export const GROUPS_IN_CRM = 'Customer groups are made and changed in ScaleEzy CRM now.';
const MAX_GROUPS = 200;
const MAX_MEMBERS = 50_000;
const ID = /^[0-9a-f-]{36}$/i;

type GroupIn = { key: string; name: string; noOfferMessages: boolean; noWishes: boolean };

/** True once CRM has sent this shop's groups: from then they are CRM's. */
export async function groupsAreCrms(clientId: string): Promise<boolean> {
  return !!(await prisma.crmGroupProjection.findUnique({ where: { clientId }, select: { clientId: true } }));
}

/**
 * For every place in Inventory that would change a group or a customer's groups. The owner, 18 Nov 2026:
 * groups are CRM's for EVERY shop, so this refuses whether or not CRM has sent the shop's copy yet (a shop
 * without CRM keeps the groups it has, read at the till, and cannot change them here). Deleting a customer
 * still clears theirs, as part of wiping the customer.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function refuseIfGroupsInCrm(_clientId: string) {
  throw conflict(GROUPS_IN_CRM);
}

function version(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) throw badRequest('Send version as a whole number of 1 or more, bigger than the last one sent.');
  return raw;
}

function cleanGroups(raw: unknown): GroupIn[] {
  if (!Array.isArray(raw)) throw badRequest('Send groups as a list of { key, name, noOfferMessages, noWishes }.');
  if (raw.length > MAX_GROUPS) throw badRequest(`A shop can have at most ${MAX_GROUPS} groups.`);
  const seen = new Set<string>();
  return raw.map((g: any, i: number) => {
    const name = String(g?.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw badRequest(`Group ${i + 1} has no name.`);
    if (name.length > MAX_TAG_LENGTH) throw badRequest(`Keep a group name under ${MAX_TAG_LENGTH} characters: "${name.slice(0, 50)}".`);
    const key = keyOf(name);
    if (g?.key !== undefined && keyOf(String(g.key)) !== key) throw badRequest(`The key of "${name}" must be its name in small letters ("${key}").`);
    if (seen.has(key)) throw badRequest(`"${name}" is in the list twice.`);
    seen.add(key);
    for (const f of ['noOfferMessages', 'noWishes'] as const) {
      if (g?.[f] !== undefined && typeof g[f] !== 'boolean') throw badRequest(`Send ${f} of "${name}" as true or false.`);
    }
    return { key, name, noOfferMessages: g?.noOfferMessages === true, noWishes: g?.noWishes === true };
  });
}

/** A customer's group names, spelt as the group is, checked against the groups the copy has. */
function namesFor(raw: unknown, byKey: Map<string, string>, who: string): string[] {
  if (!Array.isArray(raw)) throw badRequest(`Send ${who}'s groups as a list of names.`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of raw) {
    const key = keyOf(String(n ?? ''));
    if (!key) continue;
    const name = byKey.get(key);
    if (!name) throw badRequest(`${who} is put in "${String(n).slice(0, 50)}", which is not one of the shop's groups.`);
    if (!seen.has(key)) { seen.add(key); out.push(name); }
  }
  if (out.length > MAX_CUSTOMER_TAGS) throw badRequest(`${who} is in more than ${MAX_CUSTOMER_TAGS} groups.`);
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Holds the shop's copy row for this write and refuses a version that is not newer. */
async function claimVersion(tx: Prisma.TransactionClient, clientId: string, v: number, mustExist: boolean) {
  if (!mustExist) {
    await tx.$executeRaw`INSERT INTO crm_group_projections (client_id, version, applied_at) VALUES (${clientId}, 0, now()) ON CONFLICT (client_id) DO NOTHING`;
  }
  const rows = await tx.$queryRaw<{ version: bigint }[]>`SELECT version FROM crm_group_projections WHERE client_id = ${clientId} FOR UPDATE`;
  if (!rows.length) throw conflict('Send the whole shop\'s groups first (PUT .../groups/projection), then one customer at a time.');
  const current = Number(rows[0].version);
  if (v <= current) {
    throw Object.assign(conflict(`Version ${v} is not newer than the ${current} already applied, so it was not applied.`), { details: { current } });
  }
}

export const crmGroups = {
  /** The whole shop's groups and members. */
  async put(clientId: string, body: any) {
    const v = version(body?.version);
    const groups = cleanGroups(body?.groups);
    const byKey = new Map(groups.map(g => [g.key, g.name]));
    const rawMembers = body?.members ?? {};
    if (typeof rawMembers !== 'object' || Array.isArray(rawMembers)) throw badRequest('Send members as { <customer id>: [group names] }.');
    const entries = Object.entries(rawMembers);
    if (entries.length > MAX_MEMBERS) throw badRequest(`Send at most ${MAX_MEMBERS.toLocaleString('en-IN')} customers at once.`);
    const wanted = new Map<string, string[]>();
    for (const [id, names] of entries) {
      if (!ID.test(id)) throw badRequest(`"${id.slice(0, 40)}" is not a customer id from Inventory.`);
      wanted.set(id.toLowerCase(), namesFor(names, byKey, `Customer ${id.slice(0, 8)}`));
    }

    return prisma.$transaction(async tx => {
      await claimVersion(tx, clientId, v, false);

      // The groups: exactly the ones sent, with CRM's rules and no auto-join of Inventory's own.
      const keys = groups.map(g => g.key);
      const removed = await tx.customerGroup.findMany({ where: { clientId, key: { notIn: keys.length ? keys : [''] } }, select: { key: true, name: true } });
      if (removed.length) await tx.customerGroup.deleteMany({ where: { clientId, key: { in: removed.map(r => r.key) } } });
      for (const g of groups) {
        const data = { name: g.name, noOfferMessages: g.noOfferMessages, noWishes: g.noWishes, autoMinSpend: null, autoDays: null, autoExcluded: [] };
        await tx.customerGroup.upsert({ where: { clientId_key: { clientId, key: g.key } }, create: { clientId, key: g.key, ...data }, update: data });
      }

      // Members: only customers whose groups really change are written, so an unchanged push is cheap
      // and sends nothing on to the change feed.
      const customers = await tx.customer.findMany({ where: { clientId, deletedAt: null }, select: { id: true, tags: true } });
      const known = new Set(customers.map(c => c.id));
      const bySet = new Map<string, { tags: string[]; ids: string[] }>();
      for (const c of customers) {
        const next = wanted.get(c.id) ?? [];
        if (same(c.tags, next)) continue;
        const k = JSON.stringify(next);
        if (!bySet.has(k)) bySet.set(k, { tags: next, ids: [] });
        bySet.get(k)!.ids.push(c.id);
      }
      let changed = 0;
      for (const { tags, ids } of bySet.values()) {
        for (let i = 0; i < ids.length; i += 1000) {
          changed += (await tx.customer.updateMany({ where: { clientId, id: { in: ids.slice(i, i + 1000) } }, data: { tags } })).count;
        }
      }
      const unknownCustomers = [...wanted.keys()].filter(id => !known.has(id));

      // Offers still aimed at a group that is gone: they now reach nobody. Said, so CRM can warn the owner.
      const offers = removed.length
        ? await tx.offer.findMany({ where: { clientId, status: { notIn: ['ARCHIVED'] as any } }, select: { name: true, customerTags: true } })
        : [];
      const goneKeys = new Set(removed.map(r => r.key));
      const offersStillUsing = offers.filter(o => o.customerTags.some(t => goneKeys.has(keyOf(t)))).map(o => o.name);

      await tx.crmGroupProjection.update({ where: { clientId }, data: { version: BigInt(v), appliedAt: new Date(), groups: groups.length, members: wanted.size } });
      return { version: v, groups: groups.length, removedGroups: removed.map(r => r.name), customersChanged: changed, unknownCustomers, offersStillUsing };
    }, { timeout: 60_000, maxWait: 15_000 });
  },

  /** One customer's groups, between whole-shop pushes. */
  async patch(clientId: string, customerId: string, body: any) {
    const v = version(body?.version);
    if (!ID.test(customerId)) throw badRequest('That is not a customer id from Inventory.');
    const id = customerId.toLowerCase();
    return prisma.$transaction(async tx => {
      await claimVersion(tx, clientId, v, true);
      const rows = await tx.customerGroup.findMany({ where: { clientId }, select: { key: true, name: true } });
      const tags = namesFor(body?.groups, new Map(rows.map(r => [r.key, r.name])), 'The customer');
      const c = await tx.customer.findFirst({ where: { clientId, id, deletedAt: null }, select: { tags: true } });
      if (!c) throw notFound('That customer was not found in this shop.');
      if (!same(c.tags, tags)) await tx.customer.update({ where: { id }, data: { tags } });
      await tx.crmGroupProjection.update({ where: { clientId }, data: { version: BigInt(v), appliedAt: new Date() } });
      return { version: v, customerId: id, groups: tags };
    }, { timeout: 20_000, maxWait: 10_000 });
  },

  /** What the copy holds now (for CRM to check it is in step). */
  async state(clientId: string) {
    const row = await prisma.crmGroupProjection.findUnique({ where: { clientId } });
    return row ? { version: Number(row.version), appliedAt: row.appliedAt, groups: row.groups, members: row.members } : null;
  }
};
