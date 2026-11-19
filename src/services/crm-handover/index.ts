/**
 * The hand-over switch: per shop, which customer features ScaleEzy CRM now runs instead of Inventory
 * (PLAN-crm.md §7). Inventory owns it, because Inventory is the one that has to stop doing the work.
 *
 * Stored on the shop's CRM subscription (module_subscriptions.moved, JSONB):
 *   { notes?, onlineViews?, card?, groups?, profile?: boolean }
 *
 * Campaigns and birthday/anniversary wishes are ScaleEzy CRM's for EVERY shop since 18 Nov 2026 (the owner),
 * with no switch, so their two old keys are gone (19 Nov): never returned, never stored. A change that still
 * carries them is accepted and they are ignored, so a CRM build that sends them cannot fail on it. Old
 * values left in the column are dropped the next time the row is read or written.
 *
 * notes, onlineViews, card and groups are plain flags CRM reads back; Inventory's screens key off "CRM is on"
 * (see auth session `modules`).
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
import { badRequest, conflict, notFound } from '../../utils/httpError';

export type Moved = {
  notes?: boolean;
  onlineViews?: boolean;
  card?: boolean;
  groups?: boolean;
  profile?: boolean;
};

const FLAGS = ['notes', 'onlineViews', 'card', 'groups', 'profile'] as const;

/** What CRM may send. campaigns and wishes are the retired keys: allowed, and ignored. */
const changeSchema = z.object({
  notes: z.boolean().optional(),
  onlineViews: z.boolean().optional(),
  card: z.boolean().optional(),
  groups: z.boolean().optional(),
  profile: z.boolean().optional(),
  campaigns: z.unknown().optional(),
  wishes: z.unknown().optional()
}).strict();

/** Only the known keys, in their known shapes: whatever else is in the column is never trusted. */
export function cleanMoved(raw: unknown): Moved {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const out: Moved = {};
  for (const k of FLAGS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  return out;
}

export const crmHandover = {
  /** What has moved for one shop; {} when CRM is on and nothing has, null when CRM is not on. */
  async get(clientId: string): Promise<Moved | null> {
    const sub = await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId, module: 'crm' } }, select: { moved: true } });
    return sub ? cleanMoved(sub.moved) : null;
  },

  /** Changes some flags, keeping the rest. One transaction holding the subscription row. */
  async set(clientId: string, raw: unknown): Promise<Moved> {
    const parsed = changeSchema.safeParse(raw ?? {});
    if (!parsed.success) throw badRequest('Send only notes, onlineViews, card, groups and profile, each as true or false.');
    const change = parsed.data;

    return prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ moved: unknown }[]>`
        SELECT moved FROM module_subscriptions WHERE client_id = ${clientId} AND module = 'crm' FOR UPDATE`;
      if (!rows.length) throw notFound('This shop has not switched CRM on.');
      const next: Moved = cleanMoved(rows[0].moved);
      for (const k of FLAGS) if (change[k] !== undefined) next[k] = change[k];
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
