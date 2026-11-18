/**
 * The hand-over switch: per shop, which customer features ScaleEzy CRM now runs instead of Inventory
 * (PLAN-crm.md §7). Inventory owns it, because Inventory is the one that has to stop doing the work.
 *
 * Stored on the shop's CRM subscription (module_subscriptions.moved, JSONB):
 *   { notes?, onlineViews?, card?, groups?, profile?, campaigns?: boolean, wishes?: { fromDay: 'YYYY-MM-DD' } | null }
 *
 * Two of them change what Inventory's background jobs do, so they keep safety rules:
 *
 *   campaigns -- only when the shop has no campaign of its own (source MANUAL) that is PREPARING,
 *     SENDING or PAUSED, so nothing is left half sent. From then Inventory's campaign tick leaves that
 *     shop's own campaigns alone, and starting one in Inventory is refused. Automatic messages (wishes
 *     until they move, the points-lapsing reminder) are not "campaigns" here and keep going.
 *
 *   wishes -- the caller does not choose the day. fromDay is the first shop day Inventory has NOT
 *     prepared (loyalty_settings.auto_prepared_for), worked out while holding that row, so it cannot
 *     fall between Inventory's daily claim and its work: a day is wished by exactly one of the two.
 *     Inventory's daily job skips birthday and anniversary wishes for days >= fromDay. Birthday gift
 *     points, lapsing points and the lapse reminder stay in Inventory.
 *
 * 18 Nov 2026, the owner: campaigns AND wishes are ScaleEzy CRM's for EVERY shop, with no switch. Inventory
 * no longer reads either flag: it starts no campaign and makes no wish for any shop (campaigns/auto.ts,
 * campaign.service.ts, sender.ts). The two keys are still stored and given back here, so CRM's build that
 * still sends them keeps working; they can be dropped once CRM no longer does.
 *
 * Everything else (notes, onlineViews, card, groups) is a plain flag CRM reads back; Inventory's screens
 * key off "CRM is on" for now (see auth session `modules`).
 *
 * profile (29 Oct) -- a customer's WhatsApp offers answer, birthday and anniversary, and deleting a
 * customer, are changed in CRM (it calls Inventory's internal-crm routes, which work whether or not
 * this is on). When on, Inventory's own screens show them read only with a link to CRM, and its app
 * routes refuse to change them (refuseIfProfileMoved), so there is one place to change them. The till's
 * consent at a sale is not affected. CRM turns it on once its screens can make these changes.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { localDayKey } from '../../utils/businessDay';
import { badRequest, conflict, notFound } from '../../utils/httpError';

export type Moved = {
  notes?: boolean;
  onlineViews?: boolean;
  card?: boolean;
  groups?: boolean;
  profile?: boolean;
  campaigns?: boolean;
  wishes?: { fromDay: string } | null;
};

/** What CRM may send. wishes: true asks to move them (Inventory picks the day), false/null gives them back. */
const changeSchema = z.object({
  notes: z.boolean().optional(),
  onlineViews: z.boolean().optional(),
  card: z.boolean().optional(),
  groups: z.boolean().optional(),
  profile: z.boolean().optional(),
  campaigns: z.boolean().optional(),
  wishes: z.boolean().nullable().optional()
}).strict();

/** Campaign states that mean "a campaign is still on its way out". */
const UNFINISHED = ['PREPARING', 'SENDING', 'PAUSED'] as const;

const nextDay = (dayKey: string) => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** Only the known keys, in their known shapes: whatever else is in the column is never trusted. */
export function cleanMoved(raw: unknown): Moved {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const out: Moved = {};
  for (const k of ['notes', 'onlineViews', 'card', 'groups', 'profile', 'campaigns'] as const) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  const w = r.wishes as any;
  if (w && typeof w === 'object' && typeof w.fromDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w.fromDay)) out.wishes = { fromDay: w.fromDay };
  else if (w === null) out.wishes = null;
  return out;
}

export const crmHandover = {
  /** What has moved for one shop; {} when CRM is on and nothing has, null when CRM is not on. */
  async get(clientId: string): Promise<Moved | null> {
    const sub = await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId, module: 'crm' } }, select: { moved: true } });
    return sub ? cleanMoved(sub.moved) : null;
  },

  /**
   * For CRM: the flags, with wishes ALWAYS carrying the first day CRM wishes (wishes are CRM's for every
   * shop). Worked out once and kept, so it never slides; a shop that moved before keeps its stored day.
   */
  async forCrm(clientId: string): Promise<Moved | null> {
    const now = await crmHandover.get(clientId);
    if (!now || now.wishes) return now;
    return crmHandover.set(clientId, { wishes: true });
  },

  /**
   * Changes some flags, keeping the rest. Refuses (409) to move campaigns while one is unfinished.
   * Runs as one transaction holding the subscription row, so two changes at once cannot both pass
   * the check, and a campaign starting at the same moment (it reads this row FOR SHARE) waits for it.
   */
  async set(clientId: string, raw: unknown): Promise<Moved> {
    const parsed = changeSchema.safeParse(raw ?? {});
    if (!parsed.success) throw badRequest('Send only notes, onlineViews, card, groups, profile and campaigns as true or false, and wishes as true (move them) or false (keep them in Inventory).');
    const change = parsed.data;
    const { timezone } = await getShopSettings(clientId);

    return prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ moved: unknown }[]>`
        SELECT moved FROM module_subscriptions WHERE client_id = ${clientId} AND module = 'crm' FOR UPDATE`;
      if (!rows.length) throw notFound('This shop has not switched CRM on.');
      const now = cleanMoved(rows[0].moved);
      const next: Moved = { ...now };
      for (const k of ['notes', 'onlineViews', 'card', 'groups', 'profile'] as const) if (change[k] !== undefined) next[k] = change[k];

      if (change.campaigns !== undefined) {
        if (change.campaigns && !now.campaigns) {
          const open = await tx.campaign.findMany({
            where: { clientId, source: 'MANUAL', status: { in: [...UNFINISHED] } },
            select: { name: true, status: true }, orderBy: { createdAt: 'asc' }, take: 5
          });
          if (open.length) {
            throw conflict(`${open.length === 1 ? 'A campaign is' : 'Campaigns are'} still going out from Inventory: ${open.map(c => `${c.name} (${c.status.toLowerCase()})`).join(', ')}. Let ${open.length === 1 ? 'it' : 'them'} finish, or stop ${open.length === 1 ? 'it' : 'them'}, first.`);
          }
        }
        next.campaigns = change.campaigns;
      }

      if (change.wishes !== undefined) {
        if (change.wishes === true) {
          if (!now.wishes) {
            // Since 18 Nov 2026 Inventory makes no wish at all, so the first day is CRM's today -- unless an
            // older Inventory build already made a wish lot for this shop today (the day the change went
            // live), in which case today was wished here and CRM starts tomorrow. Never both, never neither.
            const today = localDayKey(new Date(), timezone);
            const wishedToday = await tx.campaign.count({
              // Counted only if it is going out or sent something: a lot stopped before anyone got it wished nobody.
              where: {
                clientId, source: { in: ['BIRTHDAY', 'ANNIVERSARY'] }, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
                OR: [{ status: { notIn: ['CANCELLED', 'DRAFT'] } }, { recipients: { some: { handedAt: { not: null } } } }]
              }
            });
            next.wishes = { fromDay: wishedToday ? nextDay(today) : today };
          }
        } else {
          next.wishes = null;
        }
      }

      await tx.moduleSubscription.update({
        where: { clientId_module: { clientId, module: 'crm' } },
        data: { moved: next as Prisma.InputJsonValue }
      });
      return next;
    }, { timeout: 20000, maxWait: 10000 });
  }
};

/**
 * For Inventory's own app routes that change a customer's offers answer, birthday, anniversary, or
 * delete them: refused once CRM does these for this shop (moved.profile). CRM's own calls come in
 * through internal-crm and never pass here.
 */
export async function refuseIfProfileMoved(clientId: string) {
  if ((await crmHandover.get(clientId))?.profile) {
    throw conflict('This shop changes WhatsApp offers, birthdays, anniversaries and deletes customers in ScaleEzy CRM now. Open the customer there.');
  }
}
