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
/**
 * THIRD TIME. Two definitions became three.
 *
 * The chain below and the one in report.service.ts drifted apart: this one stopped at
 * compare_at_price, that one continued to selling_price and base_price. So the console and the
 * merchant's own dashboard valued the same stock differently, which is precisely the bug this
 * file was created to end. Measured again across every tenant holding stock, FIVE of twenty-nine
 * still disagreed -- demo-client by ten lakh, sphl by twenty-one.
 *
 * report.service.ts now imports this constant rather than keeping its own copy, so there is one
 * chain and no way for them to drift again.
 *
 * The order is how well the figure is known, costs before prices:
 *
 *   average_cost        the weighted average actually paid, when a stock-in carried a cost
 *   last_purchase_cost  what the most recent purchase order paid
 *   cost_price          what the shopkeeper typed on the product
 *   selling_price       the variant's own price -- a PRICE, so it overstates by the margin
 *   compare_at_price    the "was" price, better than nothing
 *   base_price          the product's price, which the Add Product wizard always asks for and
 *                       so is the one figure effectively never missing
 *
 * The last three are prices rather than costs, which overstates the figure. That is deliberate
 * and disclosed: a shop holding real stock seeing zero reads as a broken app, and the dashboard
 * tile says how many units were valued that way. An unexplained number is the thing to avoid,
 * in either direction.
 *
 * NULLIF at every step because these columns hold 0 rather than NULL when unset -- a plain
 * COALESCE stops at the first zero and returns it, which is how a shop with a perfectly good
 * cost price still valued at nothing.
 */
export const UNIT_COST = Prisma.sql`COALESCE(
  NULLIF(v.average_cost, 0),
  NULLIF(v.last_purchase_cost, 0),
  NULLIF(v.cost_price, 0),
  NULLIF(v.selling_price, 0),
  NULLIF(v.compare_at_price, 0),
  NULLIF(p.base_price, 0),
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

/**
 * How much of that figure is a guess.
 *
 * The chain above falls through to PRICES when no cost was ever recorded, so a shop that
 * never fills in the optional cost box is valued at what it sells for -- overstated by its
 * entire margin. That is the right trade (a shop holding real stock seeing zero reads as a
 * broken app) but only while it is disclosed.
 *
 * The merchant's dashboard has always said so. The platform console showed the same inflated
 * number with no explanation, which is worse for Scaleezy than for the merchant: the merchant
 * knows they never entered costs, and Scaleezy is looking at forty shops and cannot tell which
 * figures are real.
 *
 * So the caveat lives beside the value, and is computed the same way for both.
 */
const PRICED_NOT_COSTED = Prisma.sql`
  COALESCE(NULLIF(v.average_cost, 0), NULLIF(v.last_purchase_cost, 0), NULLIF(v.cost_price, 0)) IS NULL
  AND COALESCE(NULLIF(v.selling_price, 0), NULLIF(v.compare_at_price, 0), NULLIF(p.base_price, 0), 0) > 0`;

export type ValuationCaveat = {
  /** Units counted at a selling price because nothing better was known. */
  unitsValuedAtPrice: number;
  /** Units held with no usable figure at all -- they contribute nothing to the total. */
  unitsWithoutAnyFigure: number;
};

/** Which part of a client's inventory value rests on a price rather than a cost. */
export async function valuationCaveatFor(clientId: string, locationId?: string): Promise<ValuationCaveat> {
  const atLocation = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<{ priced: number | null; unknown: number | null }[]>`
    SELECT
      COALESCE(SUM(CASE WHEN ${PRICED_NOT_COSTED} THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::int AS "priced",
      COALESCE(SUM(CASE WHEN ${UNIT_COST} = 0 THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::int AS "unknown"
    FROM inventory_product_variants v
    JOIN inventory_products p ON v.product_id = p.id
    LEFT JOIN (
      SELECT variant_id, SUM(quantity) AS qty
      FROM inventory_stocks
      WHERE client_id = ${clientId} ${atLocation}
      GROUP BY variant_id
    ) s ON s.variant_id = v.id
    WHERE v.client_id = ${clientId} AND p.status != 'TRASHED' AND COALESCE(s.qty, 0) > 0
  `;

  return {
    unitsValuedAtPrice: Number(rows?.[0]?.priced ?? 0),
    unitsWithoutAnyFigure: Number(rows?.[0]?.unknown ?? 0)
  };
}
