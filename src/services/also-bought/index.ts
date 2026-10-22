import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/**
 * "CUSTOMERS WHO BOUGHT THIS ALSO BOUGHT" -- from the shop's own bills, nothing guessed.
 *
 * A buyer is a person, not a bill: the same phone across the till and the online shop is one buyer
 * (online orders whose number was not proved sit on separate customer records, but carry the typed
 * number). The shared rows for bills with no customer (till walk-ins, Shopify guests) are nobody:
 * otherwise every walk-in bill would be "one customer who bought everything".
 *
 * A product is shown only when at least MIN_BUYERS different people bought both, so one person's
 * odd basket never turns into a suggestion for everybody. Cancelled and deleted orders do not count.
 */
const SHARED_CUSTOMERS = ['POS:WALK-IN', 'shopify:guest'];
export const MIN_BUYERS = 2;
/** Older baskets say less about what goes together now. */
const LOOK_BACK_MS = 2 * 365 * 86_400_000;

export type AlsoBought = { productId: string; buyers: number };

/**
 * Products bought by people who also bought any of `productIds`, most shared buyers first.
 * Never returns one of `productIds` itself, nor anything in `exclude`.
 */
export async function alsoBought(
  clientId: string,
  productIds: string[],
  opts: { exclude?: string[]; limit?: number; minBuyers?: number; now?: Date } = {}
): Promise<AlsoBought[]> {
  if (!productIds.length) return [];
  const skip = [...new Set([...productIds, ...(opts.exclude ?? [])])];
  const since = new Date((opts.now ?? new Date()).getTime() - LOOK_BACK_MS);
  // Who bought what: one row per (person, product). A person is the last ten digits of the number on
  // the order, else on the customer, else the customer record itself.
  const rows = await prisma.$queryRaw<{ product_id: string; buyers: bigint }[]>(Prisma.sql`
    WITH bought AS (
      SELECT DISTINCT
        COALESCE(
          NULLIF(RIGHT(regexp_replace(COALESCE(so.customer_phone, ''), '\\D', '', 'g'), 10), ''),
          NULLIF(RIGHT(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g'), 10), ''),
          so.customer_id
        ) AS who,
        v.product_id
      FROM sales_orders so
      JOIN customers c ON c.id = so.customer_id
      JOIN sales_order_items i ON i.sales_order_id = so.id
      JOIN inventory_product_variants v ON v.id = i.variant_id
      WHERE so.client_id = ${clientId}
        AND so.deleted_at IS NULL
        AND so.status::text <> 'CANCELLED'
        AND so.created_at >= ${since}
        AND (NULLIF(so.customer_phone, '') IS NOT NULL
             OR c.external_customer_id IS NULL
             OR c.external_customer_id NOT IN (${Prisma.join(SHARED_CUSTOMERS)}))
    ),
    buyers AS (SELECT DISTINCT who FROM bought WHERE product_id IN (${Prisma.join(productIds)}))
    SELECT b.product_id, COUNT(DISTINCT b.who) AS buyers
    FROM bought b JOIN buyers w ON w.who = b.who
    WHERE b.product_id NOT IN (${Prisma.join(skip)})
    GROUP BY b.product_id
    HAVING COUNT(DISTINCT b.who) >= ${opts.minBuyers ?? MIN_BUYERS}
    ORDER BY buyers DESC, b.product_id
    LIMIT ${opts.limit ?? 24}
  `);
  return rows.map(r => ({ productId: r.product_id, buyers: Number(r.buyers) }));
}

/**
 * The same, addressed by product code, for the online shop (which never reads product tables itself).
 * Only live products come back: nothing archived, binned or still a draft.
 */
export async function alsoBoughtCodes(clientId: string, productCode: string, limit = 24): Promise<string[]> {
  const product = await prisma.product.findFirst({ where: { clientId, productCode }, select: { id: true } });
  if (!product) return [];
  const together = await alsoBought(clientId, [product.id], { limit });
  if (!together.length) return [];
  const live = await prisma.product.findMany({
    where: { id: { in: together.map(t => t.productId) }, clientId, status: 'ACTIVE', trashedAt: null },
    select: { id: true, productCode: true }
  });
  const codeOf = new Map(live.map(p => [p.id, p.productCode]));
  return together.map(t => codeOf.get(t.productId)).filter((c): c is string => !!c);
}
