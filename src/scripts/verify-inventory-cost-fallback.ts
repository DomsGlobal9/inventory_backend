/**
 * One valuation rule, in two renderings, against every shop's real stock.
 *
 * lib/inventoryValuation holds the rule twice on purpose: UNIT_COST as SQL, for the queries that
 * sum a whole tenant, and unitCostOf as TypeScript, for the screens that list variants through
 * Prisma and cannot reach a raw fragment. Two renderings of one rule is exactly how that rule
 * came to have three copies that disagreed and showed a merchant one number and the platform
 * console another -- so this checks them against each other on real rows rather than on a
 * fixture, because the disagreements were always about columns that hold 0 instead of NULL.
 *
 * It also checks the thing the merchant actually sees: that the Inventory table and the dashboard
 * now value the same goods identically, and that a figure resting on a selling price says so.
 *
 *   npx tsx src/scripts/verify-inventory-cost-fallback.ts
 */
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { UNIT_COST, unitCostOf, isEstimatedBasis } from '../lib/inventoryValuation';
import { inventoryService } from '../services/inventory.service';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

const CLIENT = `cost-fb-${Date.now()}`;

async function main() {
  console.log('\nA. THE SQL AND THE TYPESCRIPT AGREE, ON EVERY REAL ROW');

  const sqlRows = await prisma.$queryRaw<{ id: string; unit_cost: string }[]>`
    SELECT v.id, ${UNIT_COST}::text AS unit_cost
    FROM inventory_product_variants v
    JOIN inventory_products p ON p.id = v.product_id
  `;
  const jsRows = await prisma.productVariant.findMany({
    select: {
      id: true, averageCost: true, lastPurchaseCost: true, costPrice: true,
      sellingPrice: true, compareAtPrice: true, product: { select: { basePrice: true } }
    }
  });
  const jsById = new Map(jsRows.map(v => [v.id, unitCostOf(v, v.product.basePrice)]));

  let compared = 0;
  const drift: string[] = [];
  for (const row of sqlRows) {
    const mine = jsById.get(row.id);
    if (!mine) continue;
    compared++;
    // Decimal text from Postgres against a JS number: compared as numbers, to the paisa.
    if (Math.abs(Number(row.unit_cost) - mine.unitCost) > 0.005) {
      drift.push(`${row.id.slice(0, 8)} sql ${row.unit_cost} vs js ${mine.unitCost}`);
    }
  }
  check('every variant in the database values the same both ways',
    compared > 0 && drift.length === 0, `${compared} variants compared, ${drift.length} disagreed`);
  if (drift.length) console.log('        ', drift.slice(0, 5).join(' | '));

  console.log('\nB. THE INVENTORY TABLE AND THE DASHBOARD NOW SAY THE SAME THING');

  /*
   * The bug this whole change exists for. Measured on swathy-reddy-boutique before it: 110 units,
   * the Inventory table said the stock was worth 0 and the dashboard said 13,76,334 -- the same
   * goods, two screens, and no way for the owner to tell which was lying.
   */
  const perClient = await prisma.$queryRaw<{ client_id: string; old_way: string; new_way: string; units: string }[]>`
    SELECT p.client_id,
           SUM(COALESCE(s.qty, 0) * COALESCE(v.average_cost, 0))::text AS old_way,
           SUM(COALESCE(s.qty, 0) * ${UNIT_COST})::text                AS new_way,
           SUM(COALESCE(s.qty, 0))::text                               AS units
    FROM inventory_product_variants v
    JOIN inventory_products p ON p.id = v.product_id
    LEFT JOIN (SELECT variant_id, SUM(quantity) AS qty FROM inventory_stocks GROUP BY variant_id) s
      ON s.variant_id = v.id
    WHERE p.trashed_at IS NULL
    GROUP BY p.client_id
    HAVING SUM(COALESCE(s.qty, 0)) > 0
  `;
  const wereZero = perClient.filter(c => Number(c.old_way) === 0 && Number(c.new_way) > 0);
  check('shops whose stock used to value at nothing now have a figure',
    wereZero.length > 0,
    wereZero.map(c => `${c.client_id}: 0 -> ${Math.round(Number(c.new_way))}`).join(', ') || 'none found');
  check('and no shop lost a figure it already had',
    perClient.every(c => Number(c.new_way) >= Number(c.old_way) - 0.01),
    perClient.filter(c => Number(c.new_way) < Number(c.old_way)).map(c => c.client_id).join(', ') || 'none');

  console.log('\nC. THE FIGURE SAYS WHERE IT CAME FROM');

  const location = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Counter', code: `CF-${Date.now() % 100000}`, type: 'STORE' as any, active: true }
  });
  const make = async (key: string, basePrice: number, v: any, qty: number) => {
    const product = await prisma.product.create({
      data: {
        clientId: CLIENT, productCode: `CF-${key}`, slug: `cf-${key.toLowerCase()}`,
        title: `Cost ${key}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
        dressType: 'Saree', basePrice: basePrice as any, status: 'ACTIVE' as any, publishedAt: new Date()
      }
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id, clientId: CLIENT, colorName: key, size: 'Free',
        variantCode: `CFV-${key}`, sku: `CFS-${key}`, ...v
      }
    });
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: variant.id, locationId: location.id, quantity: qty, reservedQty: 0 }
    });
    return variant.id;
  };

  // One product per step of the chain, each with the steps above it left at zero.
  await make('AVG', 5000, { averageCost: 1200 as any, sellingPrice: 5000 as any }, 3);
  await make('LASTPO', 5000, { lastPurchaseCost: 1100 as any, sellingPrice: 5000 as any }, 3);
  await make('COSTP', 5000, { costPrice: 1000 as any, sellingPrice: 5000 as any }, 3);
  await make('SELL', 5000, { sellingPrice: 4800 as any }, 3);
  await make('BASE', 4500, {}, 3);
  await make('NOTHING', 0, {}, 3);

  const listed: any = await inventoryService.getVariants(CLIENT, { page: 1, limit: 50 } as any);
  const rows: any[] = listed.items ?? listed.data ?? listed;
  const bySku = new Map(rows.map(r => [r.sku, r]));

  const expect = (sku: string, basis: string, cost: number, estimate: boolean) => {
    const r = bySku.get(sku);
    check(`${sku} is valued from ${basis}`,
      r?.costBasis === basis && Math.abs(Number(r?.averageCost) - cost) < 0.01,
      `${r?.costBasis} @ ${r?.averageCost}`);
    check(`  and is ${estimate ? 'marked an estimate' : 'NOT marked an estimate'}`,
      r?.costIsEstimate === estimate, String(r?.costIsEstimate));
  };

  expect('CFS-AVG', 'AVERAGE', 1200, false);
  expect('CFS-LASTPO', 'LAST_PURCHASE', 1100, false);
  expect('CFS-COSTP', 'COST_PRICE', 1000, false);
  expect('CFS-SELL', 'SELLING', 4800, true);
  expect('CFS-BASE', 'BASE', 4500, true);
  expect('CFS-NOTHING', 'NONE', 0, false);

  console.log('\nD. A COST IS PREFERRED TO A PRICE, ALWAYS');
  const avg = bySku.get('CFS-AVG');
  check('a variant with both takes the cost, not the higher selling price',
    Number(avg?.averageCost) === 1200, `${avg?.averageCost} (selling price is 5000)`);
  check('and its value is the cost times what is on hand, not the retail total',
    Number(avg?.inventoryValue) === 3600, String(avg?.inventoryValue));

  console.log('\nE. THE VALUE COLUMN MATCHES THE COST COLUMN ON EVERY ROW');
  const mismatched = rows.filter(r => Math.abs(Number(r.inventoryValue) - Number(r.averageCost) * r.quantity) > 0.01);
  check('value is always cost x quantity, so the two columns cannot contradict each other',
    mismatched.length === 0,
    mismatched.map(r => `${r.sku}: ${r.averageCost}x${r.quantity} != ${r.inventoryValue}`).join(', ') || 'all consistent');

  console.log('\nF. SORTING USES THE FIGURE THE TABLE IS SHOWING');
  /*
   * Ordering by the average_cost column in the database would have sorted almost every row of a
   * shop that never entered costs as 0, while the table displayed a price beside it -- a column
   * visibly not in the order it claims to be.
   */
  const desc: any = await inventoryService.getVariants(CLIENT, { page: 1, limit: 50, sortBy: 'averageCost', order: 'desc' } as any);
  const descCosts = (desc.items ?? desc.data ?? desc).map((r: any) => Number(r.averageCost));
  check('highest cost first really is highest first',
    descCosts.every((c: number, i: number) => i === 0 || descCosts[i - 1] >= c),
    JSON.stringify(descCosts));

  const asc: any = await inventoryService.getVariants(CLIENT, { page: 1, limit: 50, sortBy: 'inventoryValue', order: 'asc' } as any);
  const ascValues = (asc.items ?? asc.data ?? asc).map((r: any) => Number(r.inventoryValue));
  check('and lowest value first really is lowest first',
    ascValues.every((v: number, i: number) => i === 0 || ascValues[i - 1] <= v),
    JSON.stringify(ascValues));

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);

  const w = { clientId: CLIENT };
  await prisma.inventoryStock.deleteMany({ where: w }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.stockLocation.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => {
  console.log('CRASHED:', e.message);
  const w = { clientId: CLIENT };
  await prisma.inventoryStock.deleteMany({ where: w }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.stockLocation.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
