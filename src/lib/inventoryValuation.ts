import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * One definition of "what is this client's stock worth".
 *
 * There used to be two, and they disagreed. The client's own dashboard computed the figure
 * live from stock x cost; the platform console summed the stored `inventory_value` column on
 * each variant. Measured across 40 tenants, 5 of them showed the merchant one number and
 * Scaleezy a different one -- in BOTH directions:
 *
 *   sphl            client 19,80,000   console 0
 *   test-client-id  client 0           console 3,06,000
 *
 * Neither screen was reading bad data. They were reading different columns. The stored column
 * is written by inventory-mutation.service.ts as qty x averageCost, so it is zero for any shop
 * that set opening stock without a costed purchase; the dashboard's chain covered exactly that
 * case but ignored averageCost, so it was zero for any shop that only ever received stock
 * through purchase orders.
 *
 * The chain below is the union of the two, in order of how much the number can be trusted:
 * a weighted average cost is what the goods actually cost, a last purchase price is what the
 * most recent ones cost, a cost price is what we expect to pay, and a base price is a
 * standing-in guess. NULLIF at every step because these columns hold 0 rather than NULL when
 * unset -- a plain COALESCE stops at the first zero and returns it, which is how a shop with a
 * perfectly good cost price still valued at nothing.
 */
const UNIT_COST = Prisma.sql`COALESCE(
  NULLIF(v.average_cost, 0),
  NULLIF(v.last_purchase_cost, 0),
  NULLIF(v.cost_price, 0),
  NULLIF(v.compare_at_price, 0),
  0
)`;

/** Stock on hand valued for one client, optionally at one location. Trashed products excluded. */
export async function inventoryValueFor(clientId: string, locationId?: string): Promise<number> {
  const atLocation = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<{ totalValue: string | null }[]>`
    SELECT SUM(COALESCE(s.qty, 0) * ${UNIT_COST}) AS "totalValue"
    FROM inventory_product_variants v
    JOIN inventory_products p ON v.product_id = p.id
    LEFT JOIN (
      SELECT variant_id, SUM(quantity) AS qty
      FROM inventory_stocks
      WHERE client_id = ${clientId} ${atLocation}
      GROUP BY variant_id
    ) s ON s.variant_id = v.id
    WHERE v.client_id = ${clientId} AND p.status != 'TRASHED'
  `;
  return Number(rows?.[0]?.totalValue ?? 0);
}

/**
 * The same figure for every tenant at once.
 *
 * One query, not one per client. The console's front page is the reason: it deliberately
 * aggregates all tenants in a fixed number of queries, and calling inventoryValueFor in a loop
 * would put the per-tenant fan-out straight back that listClients was rewritten to remove.
 */
export async function inventoryValueByClient(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ client_id: string; totalValue: string | null }[]>`
    SELECT v.client_id, SUM(COALESCE(s.qty, 0) * ${UNIT_COST}) AS "totalValue"
    FROM inventory_product_variants v
    JOIN inventory_products p ON v.product_id = p.id
    LEFT JOIN (
      SELECT client_id, variant_id, SUM(quantity) AS qty
      FROM inventory_stocks
      GROUP BY client_id, variant_id
    ) s ON s.variant_id = v.id AND s.client_id = v.client_id
    WHERE p.status != 'TRASHED'
    GROUP BY v.client_id
  `;
  return new Map(rows.map(r => [r.client_id, Number(r.totalValue ?? 0)]));
}
