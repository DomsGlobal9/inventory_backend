/**
 * Verifies the reports page's endpoints.
 *
 * These endpoints existed for a long time with no caller, which means nothing ever checked
 * them. The properties that matter are: they refuse anonymous callers, they answer only for
 * the calling tenant, their numbers agree with the database rather than with each other, and
 * their query parameters actually do something -- ?days= was accepted and silently ignored
 * for the dead-stock report until it was fixed, which is exactly the failure a test that only
 * asserts "returns 200" cannot see.
 *
 *   npx ts-node src/scripts/verify-reports.ts
 */
import { prisma } from '../lib/prisma';

const BASE = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const TENANT_EMAIL = 'e2e1788452461634@example.com';
const TENANT_PASSWORD = process.env.TEST_TENANT_PASSWORD || '0B-GWDgJRCuK';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

class Jar {
  private c = new Map<string, string>();
  capture(res: Response) {
    for (const line of ((res.headers as any).getSetCookie?.() || [])) {
      const [pair] = String(line).split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function call(method: string, path: string, jar?: Jar, body?: any) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const cookie = jar?.header();
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  jar?.capture(res);
  let json: any = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const ENDPOINTS = [
  '/reports/inventory-summary',
  '/reports/open-po-value',
  '/reports/low-stock-value',
  '/reports/category-value',
  '/reports/movement-aging',
  '/reports/dead-stock',
  '/reports/supplier-spend',
  '/reports/stock-movement',
  '/reports/recent-transactions',
  '/reports/inventory-value'
];

async function main() {
  console.log(`\nVerifying reports against ${BASE}\n`);

  const owner = await prisma.user.findFirst({ where: { email: TENANT_EMAIL }, select: { clientId: true } });
  if (!owner) throw new Error('Test tenant not found');
  const clientId = owner.clientId;

  const jar = new Jar();
  const login = await call('POST', '/auth/login', jar, { email: TENANT_EMAIL, password: TENANT_PASSWORD });
  if (login.status !== 200) throw new Error(`Login failed (${login.status})`);

  // --- ACCESS ---------------------------------------------------------------
  console.log('ACCESS');
  for (const ep of ENDPOINTS) {
    const anon = await call('GET', ep);
    check(`${ep} refuses an anonymous caller`, anon.status === 401, `got ${anon.status}`);
  }

  // --- THEY ANSWER ----------------------------------------------------------
  console.log('\nTHEY ANSWER');
  const data: Record<string, any> = {};
  for (const ep of ENDPOINTS) {
    const r = await call('GET', ep, jar);
    data[ep] = r.json?.data;
    check(`${ep} answers`,
      r.status === 200 && r.json?.success === true && r.json?.data !== undefined,
      `status ${r.status}`);
  }

  // --- THE NUMBERS AGREE WITH THE DATABASE ----------------------------------
  console.log('\nAGAINST THE DATABASE');

  const summary = data['/reports/inventory-summary'];
  const liveUnits = (await prisma.inventoryStock.aggregate({
    where: { clientId }, _sum: { quantity: true }
  }))._sum.quantity || 0;
  check('inventory-summary units equal the stock actually held',
    summary?.totalUnits === liveUnits, `${summary?.totalUnits} vs ${liveUnits}`);

  const activeProducts = await prisma.product.count({ where: { clientId, status: 'ACTIVE' } });
  check('inventory-summary counts only ACTIVE products',
    summary?.totalProducts === activeProducts, `${summary?.totalProducts} vs ${activeProducts}`);

  const variantCount = await prisma.productVariant.count({ where: { clientId } });
  check('inventory-summary counts every variant',
    summary?.totalVariants === variantCount, `${summary?.totalVariants} vs ${variantCount}`);

  const openPoDb = await prisma.purchaseOrder.aggregate({
    where: { clientId, status: { in: ['SENT', 'PARTIALLY_RECEIVED'] } }, _sum: { totalAmount: true }
  });
  check('open-po-value matches the sent-but-not-received orders',
    Number(data['/reports/open-po-value']?.openPoValue) === Number(openPoDb._sum.totalAmount || 0),
    `${data['/reports/open-po-value']?.openPoValue} vs ${openPoDb._sum.totalAmount}`);

  const spendDb = await prisma.purchaseOrder.groupBy({
    by: ['supplierId'],
    where: { clientId, status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] } },
    _sum: { totalAmount: true }
  });
  const spendApi = data['/reports/supplier-spend'] || [];
  check('supplier-spend lists every supplier that has been paid',
    spendApi.length === spendDb.length, `${spendApi.length} vs ${spendDb.length}`);

  const spendTotalDb = spendDb.reduce((a, s) => a + Number(s._sum.totalAmount || 0), 0);
  const spendTotalApi = spendApi.reduce((a: number, s: any) => a + s.totalSpend, 0);
  check('supplier-spend totals match the database',
    spendTotalApi === spendTotalDb, `${spendTotalApi} vs ${spendTotalDb}`);

  check('supplier-spend is ordered biggest first',
    spendApi.every((s: any, i: number) => i === 0 || spendApi[i - 1].totalSpend >= s.totalSpend));

  const unknowns = spendApi.filter((s: any) => s.supplierName === 'Unknown');
  check('supplier-spend resolves every supplier name',
    unknowns.length === 0, JSON.stringify(unknowns));

  // Aging buckets partition the stocked items, so they must add back up to the whole.
  const aging = data['/reports/movement-aging'] || [];
  const agingCovered = aging.reduce((a: number, r: any) => a + r.variantCount, 0);
  const stocked = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*)::int as c FROM "inventory_product_variants" v
    LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} GROUP BY variant_id) s
      ON s.variant_id = v.id
    WHERE v.client_id = ${clientId} AND COALESCE(s.qty,0) > 0 AND v.last_movement_at IS NOT NULL`;
  check('movement-aging buckets cover every stocked item exactly once',
    agingCovered === stocked[0].c, `${agingCovered} vs ${stocked[0].c}`);
  check('movement-aging uses only the four known buckets',
    aging.every((r: any) => ['0-30', '31-60', '61-90', '90+'].includes(r.ageBracket)),
    JSON.stringify(aging.map((r: any) => r.ageBracket)));

  const catValue = (data['/reports/category-value'] || []).reduce((a: number, c: any) => a + c.totalValue, 0);
  const totalValueDb = Number((await prisma.productVariant.aggregate({
    where: { clientId }, _sum: { inventoryValue: true }
  }))._sum.inventoryValue || 0);
  check('category-value adds up to the whole inventory value',
    Math.abs(catValue - totalValueDb) < 0.01, `${catValue} vs ${totalValueDb}`);

  // --- PARAMETERS ACTUALLY DO SOMETHING -------------------------------------
  console.log('\nPARAMETERS DO SOMETHING');

  // The bug this catches: ?days= was parsed, passed down, and then ignored by a hardcoded
  // 90-day interval in the SQL, so every threshold returned the same answer.
  const dead1 = (await call('GET', '/reports/dead-stock?days=1', jar)).json?.data || [];
  const dead3650 = (await call('GET', '/reports/dead-stock?days=3650', jar)).json?.data || [];
  check('a shorter dead-stock window never finds fewer items than a longer one',
    dead1.length >= dead3650.length, `days=1 -> ${dead1.length}, days=3650 -> ${dead3650.length}`);
  check('the dead-stock window changes the answer',
    dead1.length !== dead3650.length,
    `both returned ${dead1.length} -- the threshold may be ignored again`);
  check('every dead-stock item really has sat still that long',
    dead1.every((r: any) => r.daysSinceLastMovement === null || r.daysSinceLastMovement >= 1),
    JSON.stringify(dead1.map((r: any) => r.daysSinceLastMovement)));
  check('dead-stock only lists items that are actually in stock',
    dead1.every((r: any) => Number(r.quantity) > 0));

  const limited = (await call('GET', '/reports/recent-transactions?limit=3', jar)).json?.data || [];
  check('recent-transactions honours its limit', limited.length <= 3, `got ${limited.length}`);

  const mv7 = (await call('GET', '/reports/stock-movement?days=7', jar)).json?.data || [];
  const mv3650 = (await call('GET', '/reports/stock-movement?days=3650', jar)).json?.data || [];
  const sum7 = mv7.reduce((a: number, m: any) => a + m.transactionCount, 0);
  const sum3650 = mv3650.reduce((a: number, m: any) => a + m.transactionCount, 0);
  check('a longer movement window never covers fewer transactions',
    sum3650 >= sum7, `7d -> ${sum7}, 3650d -> ${sum3650}`);

  // --- RUBBISH INPUT --------------------------------------------------------
  console.log('\nRUBBISH INPUT IS SURVIVED');
  const injection = '1;DROP TABLE inventory_products;--';
  const junk = [
    '/reports/dead-stock?days=abc',
    '/reports/dead-stock?days=-5',
    '/reports/dead-stock?days=',
    '/reports/dead-stock?days=99999999999999999999',
    `/reports/dead-stock?days=${encodeURIComponent(injection)}`,
    '/reports/stock-movement?days=NaN',
    '/reports/recent-transactions?limit=0',
    '/reports/recent-transactions?limit=-3',
    '/reports/recent-transactions?limit=999999'
  ];
  for (const path of junk) {
    const r = await call('GET', path, jar);
    const [route, qs] = path.split('?');
    check(`${route.split('/').pop()} survives "${decodeURIComponent(qs)}"`,
      r.status === 200 && Array.isArray(r.json?.data), `status ${r.status}`);
  }
  const stillThere = await prisma.product.count({ where: { clientId } });
  check('the products table survived the injection attempt', stillThere > 0, `${stillThere} products`);

  // --- TENANT ISOLATION -----------------------------------------------------
  console.log('\nTENANT ISOLATION');
  const otherSupplier = await prisma.supplier.findFirst({
    where: { clientId: { not: clientId } }, select: { id: true, name: true }
  });
  check("supplier-spend never names another tenant's supplier",
    !otherSupplier || !spendApi.some((s: any) => s.supplierId === otherSupplier.id),
    otherSupplier ? `would have leaked ${otherSupplier.name}` : 'no other tenant to compare');

  const otherVariants = await prisma.productVariant.count({ where: { clientId: { not: clientId } } });
  check('inventory-summary counts this tenant only',
    summary?.totalVariants === variantCount && otherVariants > 0,
    `${summary?.totalVariants} here, ${otherVariants} belonging to other tenants`);

  const deadSkus = [...new Set(dead1.map((r: any) => r.sku))] as string[];
  const mine = await prisma.productVariant.count({ where: { clientId, sku: { in: deadSkus } } });
  check('every dead-stock row belongs to this tenant',
    deadSkus.length === 0 || mine === deadSkus.length, `${mine} of ${deadSkus.length} are this tenant's`);

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
