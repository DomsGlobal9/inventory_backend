import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/**
 * How often shoppers tried each garment on, and in which colour (28 Oct).
 *
 * Totals only, by day and place: the owner wants to know which pieces people want to see on
 * themselves -- and which of those they then do not buy -- not who tried them. So there is no
 * customer and no photograph anywhere in here, and nothing of it goes to CRM.
 *
 * Places: TAG (the QR on the garment), SHOP_PAGE (the online shop), COUNTER (staff at the counter).
 * A refusal before the try-on started (out of allowance, no photograph) is not a try-on and is not
 * counted; a try-on that started and broke is counted as failed.
 */

export type TryOnPlace = 'TAG' | 'SHOP_PAGE' | 'COUNTER';
export type GarmentRef = { productId: string; colour?: string | null };

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
/** Fewer tries than this is not yet a pattern worth showing in "most tried, least bought". */
const MIN_TRIES = 3;

const daysOf = (raw: unknown) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_DAYS) : DEFAULT_DAYS;
};
const colourOf = (c: string | null | undefined) => (c ?? '').trim().slice(0, 80);

export const garmentTryOns = {
  /** Never awaited by the try-on itself and never throws: the count must not fail what it counts. */
  async record(clientId: string, garment: GarmentRef | null | undefined, place: TryOnPlace, ok: boolean) {
    if (!clientId || !garment?.productId) return;
    try {
      await prisma.$executeRaw`
        INSERT INTO garment_tryon_days (client_id, product_id, colour, day, place, completed, failed)
        VALUES (${clientId}, ${garment.productId}, ${colourOf(garment.colour)},
                (NOW() AT TIME ZONE 'Asia/Kolkata')::date, ${place}, ${ok ? 1 : 0}, ${ok ? 0 : 1})
        ON CONFLICT (client_id, product_id, colour, day, place) DO UPDATE SET
          completed = garment_tryon_days.completed + EXCLUDED.completed,
          failed    = garment_tryon_days.failed + EXCLUDED.failed`;
    } catch (e: any) {
      console.error(`[GarmentTryOns] could not count a try-on for ${clientId}:`, e?.message);
    }
  },

  /**
   * One garment over the last `days`: try-ons (completed ones; a broken try-on showed the shopper
   * nothing), per colour, next to how many of that colour sold in the same days.
   */
  async forProduct(clientId: string, productId: string, rawDays?: unknown) {
    const days = daysOf(rawDays);
    const since = sinceDay(days);
    const [tries, sold] = await Promise.all([
      prisma.$queryRaw<{ colour: string; place: string; completed: number; failed: number }[]>`
        SELECT colour, place, SUM(completed)::int AS completed, SUM(failed)::int AS failed
        FROM garment_tryon_days
        WHERE client_id = ${clientId} AND product_id = ${productId} AND day >= ${since}::date
        GROUP BY colour, place`,
      soldByColour(clientId, [productId], days)
    ]);

    const colours = new Map<string, { colour: string | null; triedOn: number; sold: number }>();
    const at = (c: string) => {
      if (!colours.has(c)) colours.set(c, { colour: c || null, triedOn: 0, sold: 0 });
      return colours.get(c)!;
    };
    const places = { TAG: 0, SHOP_PAGE: 0, COUNTER: 0 } as Record<TryOnPlace, number>;
    let failed = 0;
    for (const t of tries) {
      at(t.colour).triedOn += t.completed;
      if (t.place in places) places[t.place as TryOnPlace] += t.completed;
      failed += t.failed;
    }
    for (const s of sold.filter(s => s.productId === productId)) {
      // Only colours somebody tried on: sales of a colour nobody tried say nothing about try-on.
      if (colours.has(s.colour)) at(s.colour).sold += s.units;
    }
    const byColour = [...colours.values()].filter(c => c.triedOn > 0).sort((a, b) => b.triedOn - a.triedOn);
    return {
      days,
      triedOn: byColour.reduce((n, c) => n + c.triedOn, 0),
      failed,
      places,
      byColour
    };
  },

  /**
   * The garments shoppers try on most but buy least, over the last `days`: tried on at least
   * MIN_TRIES times, ordered by how rarely a try-on ended in a sale, then by most tried. These are
   * the pieces whose fit, price or photograph is worth a second look.
   */
  async mostTriedLeastBought(clientId: string, rawDays?: unknown, rawLimit?: unknown) {
    const days = daysOf(rawDays);
    const limit = Math.min(Math.max(Number(rawLimit) || 10, 1), 50);
    const tried = await prisma.$queryRaw<{ product_id: string; tried: number }[]>`
      SELECT product_id, SUM(completed)::int AS tried
      FROM garment_tryon_days
      WHERE client_id = ${clientId} AND day >= ${sinceDay(days)}::date
      GROUP BY product_id
      HAVING SUM(completed) >= ${MIN_TRIES}`;
    if (!tried.length) return { days, minTries: MIN_TRIES, items: [] };

    const ids = tried.map(t => t.product_id);
    const [products, sold] = await Promise.all([
      prisma.product.findMany({
        where: { clientId, id: { in: ids }, trashedAt: null },
        select: {
          id: true, title: true, productCode: true,
          images: { orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }, { createdAt: 'asc' }], take: 1, select: { url: true } }
        }
      }),
      soldByColour(clientId, ids, days)
    ]);
    const units = new Map<string, number>();
    for (const s of sold) units.set(s.productId, (units.get(s.productId) ?? 0) + s.units);

    const items = tried.flatMap(t => {
      const p = products.find(x => x.id === t.product_id);
      if (!p) return [];   // trashed since: nothing to act on
      const soldUnits = units.get(p.id) ?? 0;
      return [{ productId: p.id, title: p.title, productCode: p.productCode, imageUrl: p.images[0]?.url ?? null, triedOn: t.tried, sold: soldUnits }];
    });
    items.sort((a, b) => (a.sold / a.triedOn) - (b.sold / b.triedOn) || b.triedOn - a.triedOn);
    return { days, minTries: MIN_TRIES, items: items.slice(0, limit) };
  },

  /** The variants table: completed try-ons per colour of this product, last `days`. */
  async coloursOf(clientId: string, productId: string, rawDays?: unknown) {
    const rows = await prisma.$queryRaw<{ colour: string; tried: number }[]>`
      SELECT colour, SUM(completed)::int AS tried FROM garment_tryon_days
      WHERE client_id = ${clientId} AND product_id = ${productId} AND day >= ${sinceDay(daysOf(rawDays))}::date
      GROUP BY colour`;
    return Object.fromEntries(rows.map(r => [r.colour, r.tried]));
  }
};

/** The first day counted, as an Indian calendar date: "last 30 days" includes today. */
function sinceDay(days: number) {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  today.setDate(today.getDate() - (days - 1));
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

/** Units sold per product and colour in the last `days`, a cancelled or deleted order left out. */
async function soldByColour(clientId: string, productIds: string[], days: number) {
  if (!productIds.length) return [];
  const rows = await prisma.$queryRaw<{ product_id: string; colour: string | null; units: number }[]>`
    SELECT v.product_id, COALESCE(v.color_name, '') AS colour, SUM(i.quantity)::int AS units
    FROM sales_order_items i
    JOIN sales_orders o ON o.id = i.sales_order_id
    JOIN inventory_product_variants v ON v.id = i.variant_id
    WHERE o.client_id = ${clientId} AND o.status <> 'CANCELLED' AND o.deleted_at IS NULL
      AND ((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date >= ${sinceDay(days)}::date
      AND v.product_id IN (${Prisma.join(productIds)})
    GROUP BY v.product_id, COALESCE(v.color_name, '')`;
  return rows.map(r => ({ productId: r.product_id, colour: r.colour ?? '', units: r.units }));
}
