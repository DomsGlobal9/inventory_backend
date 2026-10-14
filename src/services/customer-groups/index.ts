/**
 * Customer groups: VIP, STAFF, WHOLESALE -- who is in them, and what each group means for WhatsApp.
 *
 * MEMBERSHIP stays where it always was, in customers.tags, because offers, campaigns and the till's
 * pricing already read it there. This module adds one small table (customer_groups) for what a group
 * IS: its spelling, its message rules and its auto-join rule. A group that only exists as a tag has no
 * row and needs none until somebody gives it a rule.
 *
 * Groups are case-insensitive ("vip" and "VIP" are one group), so everything here works on the lower
 * case `key` and matches every spelling a shop has used.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { MAX_CUSTOMER_TAGS, MAX_TAG_LENGTH } from '../offers/rules';

export type GroupPurpose = 'offers' | 'wishes';

const MAX_IDS = 500;
/** The shared rows bills with no customer details go on (pos-events WALK_IN_KEY, Shopify ingest). Their
 *  "spend" is every anonymous sale, so a spending rule would make them VIPs within the hour. */
const SHARED_CUSTOMERS = ['POS:WALK-IN', 'shopify:guest'];
const liveOrder = { status: { not: 'CANCELLED' as const }, deletedAt: null };

export const keyOf = (name: string) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function cleanName(raw: unknown): string {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('Give the group a name.');
  if (name.length > MAX_TAG_LENGTH) throw badRequest(`Keep a group name under ${MAX_TAG_LENGTH} characters.`);
  return name;
}

/** Every spelling this shop has used for these groups, as they sit in customers.tags. */
export async function spellingsOf(clientId: string, keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const rows = await prisma.$queryRaw<{ tag: string }[]>`
    SELECT DISTINCT t AS tag FROM customers c, UNNEST(c.tags) t
     WHERE c.client_id = ${clientId} AND lower(t) IN (${Prisma.join(keys)})`;
  return rows.map(r => r.tag);
}

/**
 * The customers a message of this kind must skip because of their groups, as a filter to AND in.
 * Null when no group of this shop has the rule, so callers add nothing.
 */
export async function quietFilter(clientId: string, purpose: GroupPurpose): Promise<Prisma.CustomerWhereInput | null> {
  const spellings = await quietSpellings(clientId, purpose);
  return spellings.length ? { NOT: { tags: { hasSome: spellings } } } : null;
}

export async function quietSpellings(clientId: string, purpose: GroupPurpose): Promise<string[]> {
  const rows = await prisma.customerGroup.findMany({
    where: { clientId, ...(purpose === 'offers' ? { noOfferMessages: true } : { noWishes: true }) },
    select: { key: true }
  });
  return spellingsOf(clientId, rows.map(r => r.key));
}

/** The quiet group a customer is in, by name, for the reason a message was skipped. */
export async function quietGroupOf(clientId: string, tags: string[], purpose: GroupPurpose): Promise<string | null> {
  if (!tags.length) return null;
  const row = await prisma.customerGroup.findFirst({
    where: { clientId, key: { in: tags.map(keyOf) }, ...(purpose === 'offers' ? { noOfferMessages: true } : { noWishes: true }) },
    select: { name: true }
  });
  return row?.name ?? null;
}

/** The name a group goes by: its row's spelling, else the spelling customers carry. Null if no such group. */
async function displayName(clientId: string, key: string): Promise<string | null> {
  const row = await prisma.customerGroup.findUnique({ where: { clientId_key: { clientId, key } }, select: { name: true } });
  if (row) return row.name;
  const [used] = await spellingsOf(clientId, [key]);
  return used ?? null;
}

async function mustExist(clientId: string, key: string): Promise<string> {
  const name = await displayName(clientId, key);
  if (!name) throw notFound('That group could not be found.');
  return name;
}

/** Offers still running (not archived) that are only for this group. */
async function offersUsing(clientId: string, key: string) {
  const offers = await prisma.offer.findMany({
    where: { clientId, status: { not: 'ARCHIVED' }, customerTags: { isEmpty: false } },
    select: { id: true, name: true, customerTags: true }
  });
  return offers.filter(o => o.customerTags.some(t => keyOf(t) === key)).map(o => ({ id: o.id, name: o.name }));
}

export const customerGroups = {
  /** Every group: the ones customers are in and the ones made empty, with counts, rules and offers. */
  async list(clientId: string) {
    const [used, rows, offers] = await Promise.all([
      prisma.$queryRaw<{ key: string; name: string; count: number }[]>`
        SELECT lower(t) AS key, MIN(t) AS name, COUNT(DISTINCT c.id)::int AS count
          FROM customers c, UNNEST(c.tags) t
         WHERE c.client_id = ${clientId} AND c.deleted_at IS NULL
         GROUP BY lower(t)`,
      prisma.customerGroup.findMany({ where: { clientId } }),
      prisma.offer.findMany({
        where: { clientId, status: { not: 'ARCHIVED' }, customerTags: { isEmpty: false } },
        select: { id: true, name: true, customerTags: true }
      })
    ]);
    const byKey = new Map<string, any>();
    for (const u of used) byKey.set(u.key, { key: u.key, name: u.name, count: u.count });
    for (const r of rows) {
      byKey.set(r.key, {
        ...(byKey.get(r.key) ?? { key: r.key, count: 0 }),
        name: r.name,
        noOfferMessages: r.noOfferMessages,
        noWishes: r.noWishes,
        autoMinSpend: r.autoMinSpend === null ? null : Number(r.autoMinSpend),
        autoDays: r.autoDays
      });
    }
    return [...byKey.values()]
      .map(g => ({
        noOfferMessages: false, noWishes: false, autoMinSpend: null, autoDays: null, ...g,
        offers: offers.filter(o => o.customerTags.some(t => keyOf(t) === g.key)).map(o => ({ id: o.id, name: o.name }))
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  },

  async members(clientId: string, key: string) {
    const name = await mustExist(clientId, key);
    const members = await prisma.$queryRaw<{ id: string; name: string; phone: string | null; customerCode: string }[]>`
      SELECT c.id, c.name, c.phone, c.customer_code AS "customerCode" FROM customers c
       WHERE c.client_id = ${clientId} AND c.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM UNNEST(c.tags) t WHERE lower(t) = ${key})
       ORDER BY c.name ASC LIMIT 1000`;
    return { key, name, members };
  },

  /** An empty group, so it can be given rules before anybody is in it. */
  async create(clientId: string, rawName: unknown) {
    const name = cleanName(rawName);
    const key = keyOf(name);
    if (await displayName(clientId, key)) throw conflict(`There is already a group called ${name}.`);
    return prisma.customerGroup.create({ data: { clientId, name, key } }).catch((e: any) => {
      if (e?.code === 'P2002') throw conflict(`There is already a group called ${name}.`);
      throw e;
    });
  },

  /**
   * Puts customers in a group, by the group's NAME so the customers list can add to a new group in one
   * step. Already in it, or already in the most groups a customer may have, is left as it is.
   */
  async addMembers(clientId: string, rawName: unknown, customerIds: unknown) {
    const ids = checkIds(customerIds);
    const asked = cleanName(rawName);
    const key = keyOf(asked);
    const name = (await displayName(clientId, key)) ?? asked;
    const [{ found, already, full }] = await prisma.$queryRaw<{ found: number; already: number; full: number }[]>`
      SELECT COUNT(*)::int AS found,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM UNNEST(tags) t WHERE lower(t) = ${key}))::int AS already,
             COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM UNNEST(tags) t WHERE lower(t) = ${key})
                                AND cardinality(tags) >= ${MAX_CUSTOMER_TAGS})::int AS full
        FROM customers WHERE client_id = ${clientId} AND deleted_at IS NULL AND id IN (${Prisma.join(ids)})`;
    const added = await prisma.$executeRaw`
      UPDATE customers SET tags = array_append(tags, ${name}), updated_at = NOW()
       WHERE client_id = ${clientId} AND deleted_at IS NULL AND id IN (${Prisma.join(ids)})
         AND NOT EXISTS (SELECT 1 FROM UNNEST(tags) t WHERE lower(t) = ${key})
         AND cardinality(tags) < ${MAX_CUSTOMER_TAGS}`;
    // `already` and `full` are as they stood just before: someone adding at the same moment can move one between them.
    return { key, name, added, alreadyIn: already, full, notFound: ids.length - found };
  },

  async removeMember(clientId: string, key: string, customerId: string) {
    await mustExist(clientId, key);
    const removed = await prisma.$executeRaw`
      UPDATE customers SET tags = ARRAY(SELECT t FROM UNNEST(tags) WITH ORDINALITY u(t, i) WHERE lower(t) <> ${key} ORDER BY i), updated_at = NOW()
       WHERE client_id = ${clientId} AND id = ${customerId}
         AND EXISTS (SELECT 1 FROM UNNEST(tags) t WHERE lower(t) = ${key})`;
    if (removed === 0) throw notFound('That customer is not in this group.');
    return { removed };
  },

  /**
   * A new name, or several groups made one (merge = rename into a name that exists).
   *
   * Changing only the spelling ("vip" -> "VIP") is always allowed and also tidies the offers that name
   * it, since matching never cared about capitals. Changing what the group IS, while a live offer is
   * only for it, is refused: the offer would silently reach nobody, and an edited offer has to be a new
   * version of it, which only the offer screen writes.
   */
  async rename(clientId: string, key: string, rawName: unknown, opts: { merge?: boolean } = {}) {
    const from = await mustExist(clientId, key);
    const to = cleanName(rawName);
    const toKey = keyOf(to);
    const target = toKey === key ? null : await displayName(clientId, toKey);
    if (toKey !== key) {
      if (target && !opts.merge) throw conflict(`There is already a group called ${target}. Use Merge to put the two together.`);
      if (!target && opts.merge) throw notFound(`There is no group called ${to} to merge into.`);
      const offers = await offersUsing(clientId, key);
      if (offers.length) {
        throw conflict(`${offers.length === 1 ? 'An offer is' : `${offers.length} offers are`} only for ${from}: ${offers.map(o => o.name).join(', ')}. Change ${offers.length === 1 ? 'it' : 'them'} to the new group first.`);
      }
    }
    const finalName = target ?? to;
    await prisma.$transaction(async tx => {
      // Drop every spelling of both groups, then add the one name: one entry, whichever they had.
      await tx.$executeRaw`
        UPDATE customers SET tags = ARRAY(SELECT t FROM UNNEST(tags) WITH ORDINALITY u(t, i)
                                           WHERE lower(t) NOT IN (${key}, ${toKey}) ORDER BY i) || ARRAY[${finalName}]::text[],
                             updated_at = NOW()
         WHERE client_id = ${clientId} AND EXISTS (SELECT 1 FROM UNNEST(tags) t WHERE lower(t) IN (${key}, ${toKey}))`;
      if (toKey === key) {
        await tx.$executeRaw`
          UPDATE offers SET customer_tags = ARRAY(SELECT CASE WHEN lower(t) = ${key} THEN ${finalName} ELSE t END
                                                    FROM UNNEST(customer_tags) WITH ORDINALITY u(t, i) ORDER BY i)
           WHERE client_id = ${clientId} AND EXISTS (SELECT 1 FROM UNNEST(customer_tags) t WHERE lower(t) = ${key})`;
        await tx.customerGroup.updateMany({ where: { clientId, key }, data: { name: finalName } });
      } else if (target) {
        // Merged: the group merged INTO keeps its own rules -- none, if it had none. The merged
        // group's rules go with it rather than quietly changing who the target reaches.
        await tx.customerGroup.deleteMany({ where: { clientId, key } });
      } else {
        await tx.customerGroup.updateMany({ where: { clientId, key }, data: { key: toKey, name: finalName } });
      }
    });
    return { key: toKey, name: finalName };
  },

  async remove(clientId: string, key: string) {
    const name = await mustExist(clientId, key);
    const offers = await offersUsing(clientId, key);
    if (offers.length) {
      throw conflict(`${offers.length === 1 ? 'An offer is' : `${offers.length} offers are`} only for ${name}: ${offers.map(o => o.name).join(', ')}. Change or archive ${offers.length === 1 ? 'it' : 'them'} first.`);
    }
    const [removed] = await prisma.$transaction([
      prisma.$executeRaw`
        UPDATE customers SET tags = ARRAY(SELECT t FROM UNNEST(tags) WITH ORDINALITY u(t, i) WHERE lower(t) <> ${key} ORDER BY i), updated_at = NOW()
         WHERE client_id = ${clientId} AND EXISTS (SELECT 1 FROM UNNEST(tags) t WHERE lower(t) = ${key})`,
      prisma.customerGroup.deleteMany({ where: { clientId, key } })
    ]);
    return { name, removedFrom: removed };
  },

  /** A group's rules. Saving an auto-join rule adds whoever already qualifies, at once. */
  async setRules(clientId: string, key: string, raw: any) {
    const name = await mustExist(clientId, key);
    const data: Prisma.CustomerGroupUncheckedUpdateInput = {};
    if (raw?.noOfferMessages !== undefined) data.noOfferMessages = raw.noOfferMessages === true;
    if (raw?.noWishes !== undefined) data.noWishes = raw.noWishes === true;
    if (raw?.autoMinSpend !== undefined || raw?.autoDays !== undefined) {
      const off = raw.autoMinSpend === null && raw.autoDays === null;
      if (off) { data.autoMinSpend = null; data.autoDays = null; }
      else {
        const spend = Number(raw.autoMinSpend), days = Number(raw.autoDays);
        if (!Number.isFinite(spend) || spend < 1 || spend > 100_000_000) throw badRequest('Enter the least they must spend, in rupees.');
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw badRequest('Enter how many days to count their spending over, from 1 to 3650.');
        data.autoMinSpend = new Prisma.Decimal(Math.round(spend * 100) / 100);
        data.autoDays = days;
      }
    }
    const upsert = () => prisma.customerGroup.upsert({
      where: { clientId_key: { clientId, key } },
      create: { clientId, key, name, ...(data as any) },
      update: data
    });
    // Two first saves at once both try to create; the loser finds the row on a second go.
    const row = await upsert().catch((e: any) => { if (e?.code === 'P2002') return upsert(); throw e; });
    const joined = row.autoDays && row.autoMinSpend ? await autoJoinGroup(clientId, row) : 0;
    return { ...row, autoMinSpend: row.autoMinSpend === null ? null : Number(row.autoMinSpend), joined };
  }
};

function checkIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some(i => typeof i !== 'string' || !i)) throw badRequest('Choose the customers to add.');
  if (raw.length > MAX_IDS) throw badRequest(`Add at most ${MAX_IDS} customers at a time.`);
  return [...new Set(raw as string[])];
}

/** Adds everyone who now meets one group's spending rule. Never takes anybody out. */
async function autoJoinGroup(clientId: string, g: { name: string; autoMinSpend: Prisma.Decimal | null; autoDays: number | null }, now = new Date()) {
  if (!g.autoMinSpend || !g.autoDays) return 0;
  const since = new Date(now.getTime() - g.autoDays * 86_400_000);
  const spenders = await prisma.salesOrder.groupBy({
    by: ['customerId'],
    where: {
      clientId, ...liveOrder, createdAt: { gte: since },
      customer: { deletedAt: null, status: 'ACTIVE', OR: [{ externalCustomerId: null }, { externalCustomerId: { notIn: SHARED_CUSTOMERS } }] }
    },
    _sum: { total: true },
    having: { total: { _sum: { gte: g.autoMinSpend } } }
  });
  const ids = spenders.map(s => s.customerId).filter((id): id is string => !!id);
  let added = 0;
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    added += (await customerGroups.addMembers(clientId, g.name, ids.slice(i, i + MAX_IDS))).added;
  }
  return added;
}

/** Every auto-join rule of every shop (or only `onlyClients`). Run by the campaigns scheduler. */
export async function runGroupAutoJoin(now = new Date(), opts: { onlyClients?: string[] } = {}) {
  const groups = await prisma.customerGroup.findMany({
    where: { autoDays: { not: null }, autoMinSpend: { not: null }, ...(opts.onlyClients ? { clientId: { in: opts.onlyClients } } : {}) }
  });
  let added = 0;
  for (const g of groups) {
    try { added += await autoJoinGroup(g.clientId, g, now); }
    catch (e) { console.error('[customer-groups] auto-join failed for a group:', (e as Error)?.message); }
  }
  return added;
}
