/**
 * What the business paid reaches only the people allowed to see it.
 *
 * `cost:view` is enforced on the response, not the route. This calls every read that carries cost
 * as five kinds of person and checks the numbers are there or gone -- by key, anywhere in the body,
 * and by the fixture's own cost appearing in the raw text under any name at all:
 *
 *   SALES        the built-in role: sees products and orders, never cost
 *   stock room   sees stock, movements and operational reports, never cost
 *   buyer        sees purchase orders and suppliers without cost:view -- keeps the prices those
 *                permissions exist to show (a supplier's agreed price, reorder suggestions), but
 *                not the valuation behind a variant
 *   ADMIN        holds cost:manage, which confers cost:view
 *   owner        holds everything
 *
 * Fixtures on demo-client (a product, a variant, a stock row, a supplier and its price, five
 * people), all removed at the end. Needs the API on :4006.
 *
 *   npx tsx src/scripts/verify-cost-visibility.ts
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { COST_FIELDS } from '../middleware/cost-visibility.middleware';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const CLIENT = 'demo-client';
const STAMP = Date.now();

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`;

/** Distinctive enough that finding it in a body means cost leaked, whatever the key was called. */
const COST = '517.35';
const SUPPLIER_PRICE = '321.45';
const REORDER_KEYS = new Set(['unitPrice', 'lineTotal', 'estimatedTotal']);

function keysIn(value: any, wanted: ReadonlySet<string>, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { value.forEach(v => keysIn(v, wanted, out)); return out; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (wanted.has(k)) out.add(k);
      keysIn(v, wanted, out);
    }
  }
  return out;
}
const costKeys = (body: any) => [...keysIn(body, COST_FIELDS)];

const created = { users: [] as string[], roles: [] as string[], productId: '', variantId: '', supplierId: '' };

async function person(name: string, roleName: string | null, keys: string[] = []): Promise<AxiosInstance> {
  let roleId: string;
  if (roleName) {
    roleId = (await prisma.role.findFirstOrThrow({ where: { clientId: CLIENT, name: roleName } })).id;
  } else {
    const role = await prisma.role.create({ data: { clientId: CLIENT, name: `COST-VERIFY-${name.toUpperCase()}-${STAMP}` } });
    created.roles.push(role.id);
    const perms = await prisma.permission.findMany({ where: { key: { in: keys } } });
    if (perms.length !== keys.length) throw new Error(`unknown permission in ${keys.join(',')}`);
    await prisma.rolePermission.createMany({ data: perms.map(p => ({ roleId: role.id, permissionId: p.id })) });
    roleId = role.id;
  }
  const user = await prisma.user.create({
    data: { clientId: CLIENT, email: `cost-verify-${name}-${STAMP}@example.com`, name: `Cost verify ${name}`, password: 'unused', status: 'ACTIVE' }
  });
  created.users.push(user.id);
  await prisma.userRole.create({ data: { userId: user.id, roleId } });
  return axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${AuthService.generateToken({ userId: user.id, clientId: CLIENT })}` },
    validateStatus: () => true
  });
}

async function main() {
  const location = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: CLIENT, code: 'MAIN-STORE' } });
  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: `PRD-COST-${STAMP}`, title: `Cost Verify Saree ${STAMP}`, slug: `cost-verify-${STAMP}`,
      category: 'WOMEN', basePrice: 1200, status: 'ACTIVE', productType: 'READY_TO_WEAR'
    }
  });
  created.productId = product.id;
  const sku = `COSTV-${STAMP}`;
  const variant = await prisma.productVariant.create({
    data: {
      clientId: CLIENT, productId: product.id, sku, variantCode: `VC-COSTV-${STAMP}`, size: 'Free', colorName: 'Red',
      sellingPrice: 1200, costPrice: Number(COST), averageCost: Number(COST), lastPurchaseCost: Number(COST), reorderLevel: 5
    }
  });
  created.variantId = variant.id;
  await prisma.inventoryStock.create({ data: { clientId: CLIENT, variantId: variant.id, locationId: location.id, quantity: 2, reservedQty: 0 } });
  const supplier = await prisma.supplier.create({ data: { clientId: CLIENT, supplierCode: `SUP-COSTV-${STAMP}`, name: `Cost Verify Weavers ${STAMP}` } as any });
  created.supplierId = supplier.id;
  await prisma.supplierProduct.create({
    data: { clientId: CLIENT, supplierId: supplier.id, variantId: variant.id, costPrice: Number(SUPPLIER_PRICE), isPreferred: true }
  });
  const order = await prisma.salesOrder.findFirst({ where: { clientId: CLIENT, deletedAt: null, items: { some: {} } }, orderBy: { createdAt: 'desc' } });

  const sales = await person('sales', 'SALES');
  const stockroom = await person('stockroom', null, [
    'inventory:view', 'inventory:receive', 'report:view', 'dashboard:view', 'product:view', 'product:update',
    'sales_order:view', 'stock_count:view'
  ]);
  const buyer = await person('buyer', null, ['purchase_order:view', 'supplier:view', 'inventory:view', 'product:view']);
  const admin = await person('admin', 'ADMIN');
  const owner = await person('owner', 'SUPER_ADMIN');
  const withoutCost = { SALES: sales, 'stock room': stockroom, buyer };
  const withCost = { ADMIN: admin, owner };

  type Read = { label: string; path: string; who: string[] };
  const reads: Read[] = [
    { label: "a product's sizes and colours", path: `/products/${product.id}/variants`, who: ['SALES', 'stock room', 'buyer'] },
    { label: 'variant search', path: `/variants/search?q=${sku}`, who: ['SALES', 'stock room', 'buyer'] },
    { label: 'the product page', path: `/products/${product.id}`, who: ['SALES', 'stock room', 'buyer'] },
    { label: 'the product list', path: `/products?search=${encodeURIComponent(product.title)}`, who: ['SALES', 'stock room', 'buyer'] },
    { label: 'global search', path: `/search?q=${sku}`, who: ['SALES', 'stock room', 'buyer'] },
    { label: 'the stock list', path: `/inventory/variants?search=${sku}`, who: ['stock room', 'buyer'] },
    { label: 'stock movements', path: '/inventory/transactions', who: ['stock room', 'buyer'] },
    { label: 'the dashboard', path: '/dashboard/summary', who: ['SALES', 'stock room'] },
    { label: 'the movement-aging report', path: '/reports/movement-aging', who: ['stock room'] },
    { label: 'the order list', path: '/sales-orders', who: ['SALES', 'stock room'] },
    ...(order ? [{ label: 'an order', path: `/sales-orders/${order.id}`, who: ['SALES', 'stock room'] }] : [])
  ];

  // ── WITHOUT cost:view ─────────────────────────────────────────────────────────────────────
  console.log('\nA. PEOPLE WHO MAY NOT SEE COST');
  for (const read of reads) {
    for (const who of read.who) {
      const r = await (withoutCost as any)[who].get(read.path);
      const keys = r.status === 200 ? costKeys(r.data) : [];
      check(`${who}: ${read.label} loads with no cost in it`,
        r.status === 200 && keys.length === 0 && !JSON.stringify(r.data).includes(COST),
        r.status === 200 ? `found ${keys.join(', ') || `the cost ${COST} under another name`}` : brief(r));
    }
  }

  const salesVariants = await sales.get(`/products/${product.id}/variants`);
  const row = (salesVariants.data?.data ?? []).find((v: any) => v.id === variant.id);
  check('SALES still gets the selling price, as a number, and the rest of the row',
    !!row && Number(row.sellingPrice) === 1200 && row.sku === sku && typeof row.sellingPrice !== 'object', JSON.stringify(row)?.slice(0, 200));

  const salesSearch = await sales.get(`/variants/search?q=${sku}`);
  const hit = (salesSearch.data?.data?.items ?? [])[0];
  check('SALES variant search still finds it, with stock and price', hit?.sku === sku && Number(hit?.sellingPrice) === 1200 && hit?.stock === 2, JSON.stringify(hit)?.slice(0, 200));

  const reorderStock = await stockroom.get('/reorder/suggestions');
  const reorderKeys = [...keysIn(reorderStock.data, new Set([...COST_FIELDS, ...REORDER_KEYS]))];
  check('stock room: reorder suggestions load without what the supplier charges',
    reorderStock.status === 200 && reorderKeys.length === 0 && !JSON.stringify(reorderStock.data).includes(SUPPLIER_PRICE), reorderStock.status === 200 ? reorderKeys.join(', ') : brief(reorderStock));
  check('  ...but still say what to reorder', JSON.stringify(reorderStock.data).includes(sku));

  const sortedByValue = await stockroom.get('/inventory/variants?sortBy=inventoryValue&order=desc&limit=20');
  const unsorted = await stockroom.get('/inventory/variants?limit=20');
  const ids = (r: any) => (r.data?.data?.items ?? []).map((v: any) => v.variantId).join();
  check('stock room: asking to sort by stock value gives the ordinary order, not the ranking',
    sortedByValue.status === 200 && ids(sortedByValue) === ids(unsorted), `${ids(sortedByValue).slice(0, 80)} vs ${ids(unsorted).slice(0, 80)}`);

  const patched = await stockroom.patch(`/variants/${variant.id}`, { reorderLevel: 5 });
  check('stock room: saving a variant answers without its cost', patched.status === 200 && costKeys(patched.data).length === 0 && !JSON.stringify(patched.data).includes(COST), brief(patched));

  // ── Permissions that show a price by design ───────────────────────────────────────────────
  console.log('\nB. PRICES A PERMISSION EXISTS TO SHOW');
  const supplierPrices = await buyer.get(`/variants/${variant.id}/suppliers`);
  check("buyer without cost:view still sees the supplier's agreed price on a variant",
    supplierPrices.status === 200 && JSON.stringify(supplierPrices.data).includes('costPrice') && JSON.stringify(supplierPrices.data).includes('321.45'), brief(supplierPrices));
  const reorderBuyer = await buyer.get('/reorder/suggestions');
  check('buyer (may see purchase orders) still sees reorder prices', reorderBuyer.status === 200 && JSON.stringify(reorderBuyer.data).includes('"unitPrice"')
    && JSON.stringify(reorderBuyer.data).includes('321.45'), brief(reorderBuyer));
  const buyerVariants = await buyer.get(`/products/${product.id}/variants`);
  check("  ...but not the variant's valuation behind it", costKeys(buyerVariants.data).length === 0, costKeys(buyerVariants.data).join(', '));

  // ── WITH cost:view ────────────────────────────────────────────────────────────────────────
  console.log('\nC. PEOPLE WHO MAY SEE COST');
  for (const [who, api] of Object.entries(withCost)) {
    const v = await api.get(`/products/${product.id}/variants`);
    const vrow = (v.data?.data ?? []).find((x: any) => x.id === variant.id);
    check(`${who}: a product's sizes carry cost, average cost and last purchase cost`,
      v.status === 200 && Number(vrow?.costPrice) === Number(COST) && Number(vrow?.averageCost) === Number(COST) && Number(vrow?.lastPurchaseCost) === Number(COST), brief(v));
    const s = await api.get(`/variants/search?q=${sku}`);
    const item = s.data?.data?.items?.[0];
    check(`${who}: variant search carries them too (the purchase-order picker needs them)`,
      s.status === 200 && Number(item?.costPrice) === Number(COST) && Number(item?.lastPurchaseCost) === Number(COST) && Number(item?.averageCost) === Number(COST), brief(s));
    const inv = await api.get(`/inventory/variants?search=${sku}`);
    const irow = inv.data?.data?.items?.[0];
    check(`${who}: the stock list carries average cost and stock value`,
      // Not quantity x cost: without a location the list reports the variant's stored value, which
      // stock movements maintain and this fixture never had. Present is what is being checked.
      inv.status === 200 && Number(irow?.averageCost) === Number(COST) && typeof irow?.inventoryValue === 'number', brief(inv));
    const tx = await api.get('/inventory/transactions');
    check(`${who}: stock movements carry unit cost`, tx.status === 200 && costKeys(tx.data).includes('unitCost'), brief(tx));
    const dash = await api.get('/dashboard/summary');
    check(`${who}: the dashboard carries stock value`, dash.status === 200 && costKeys(dash.data).includes('inventoryValue'), brief(dash));
    if (order) {
      const o = await api.get(`/sales-orders/${order.id}`);
      check(`${who}: an order's lines carry cost and profit`, o.status === 200 && costKeys(o.data).includes('unitCost') && costKeys(o.data).includes('grossProfit'), brief(o));
    }
  }

  const adminSorted = await admin.get('/inventory/variants?sortBy=inventoryValue&order=desc&limit=5');
  const values = (adminSorted.data?.data?.items ?? []).map((v: any) => Number(v.inventoryValue));
  check('ADMIN: sorting by stock value still sorts by it', adminSorted.status === 200 && values.every((v: number, i: number) => i === 0 || values[i - 1] >= v), values.join());
}

async function cleanup() {
  await prisma.userRole.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: created.users } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: created.roles } } });
  await prisma.role.deleteMany({ where: { id: { in: created.roles } } });
  if (created.variantId) {
    await prisma.inventoryAlert.deleteMany({ where: { variantId: created.variantId } }).catch(() => undefined);
    await prisma.supplierProduct.deleteMany({ where: { variantId: created.variantId } });
    await prisma.inventoryStock.deleteMany({ where: { variantId: created.variantId } });
    await prisma.productVariant.deleteMany({ where: { id: created.variantId } });
  }
  if (created.supplierId) await prisma.supplier.deleteMany({ where: { id: created.supplierId } });
  if (created.productId) await prisma.product.deleteMany({ where: { id: created.productId } });

  const left = [
    await prisma.user.count({ where: { id: { in: created.users } } }),
    await prisma.role.count({ where: { id: { in: created.roles } } }),
    await prisma.product.count({ where: { productCode: `PRD-COST-${STAMP}` } }),
    await prisma.productVariant.count({ where: { sku: `COSTV-${STAMP}` } }),
    await prisma.supplier.count({ where: { supplierCode: `SUP-COSTV-${STAMP}` } })
  ];
  check('cleanup left nothing behind on demo-client', left.every(n => n === 0), left.join());
}

main()
  .catch(error => { failed++; failures.push(`crashed: ${error?.message}`); console.error(error); })
  .finally(async () => {
    try { await cleanup(); } catch (error: any) { failed++; console.error('cleanup failed', error); }
    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
