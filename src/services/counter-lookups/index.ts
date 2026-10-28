import { prisma } from '../../lib/prisma';

/**
 * The counter history (28 Oct): each Customer card look-up -- who looked the customer up, in which
 * store, and what the card put in front of them. The counter stays in Inventory, where salespeople
 * already have their sign-in and permissions; this row is how CRM still sees it. A database
 * trigger (migration 20261028210000) puts each new row in the module outbox as
 * counter_lookup.created, for shops on CRM only.
 */

/** Looking the same customer up again within this time (a re-tap, a refresh) is the same visit. */
const SAME_VISIT_MS = 10 * 60 * 1000;
const MAX_ITEMS = 12;

type Shown = { productId: string; variantId?: string | null; title: string; colour?: string | null; size?: string | null };
const brief = (list: unknown): Shown[] =>
  (Array.isArray(list) ? list : []).slice(0, MAX_ITEMS).flatMap((x: any) => x?.productId
    ? [{ productId: x.productId, variantId: x.variantId ?? null, title: x.title ?? '', colour: x.colour ?? null, size: x.size ?? null }]
    : []);

export const counterLookups = {
  /** Never awaited by the look-up and never throws: the history must not fail the card. */
  async record(clientId: string, by: { id: string | null; name: string | null }, card: any, locationId?: string) {
    const customerId = card?.customer?.id;
    if (!clientId || !customerId) return;
    try {
      const recent = await prisma.counterLookup.findFirst({
        where: { clientId, customerId, userId: by.id, locationId: locationId ?? null, createdAt: { gt: new Date(Date.now() - SAME_VISIT_MS) } },
        select: { id: true }
      });
      if (recent) return;
      await prisma.counterLookup.create({
        data: {
          clientId, customerId, locationId: locationId ?? null, userId: by.id, userName: by.name,
          picks: brief(card.picks) as any,
          alsoBought: brief(card.othersAlsoBought) as any,
          lookedOnline: brief(card.lookedOnline) as any
        }
      });
    } catch (e: any) {
      console.error(`[CounterLookups] could not keep a look-up for ${clientId}:`, e?.message);
    }
  }
};
