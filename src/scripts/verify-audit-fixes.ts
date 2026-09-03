/**
 * Targeted verification for the audit fixes. run-full-test.ts covers the happy paths;
 * this covers the specific broken behaviours that were fixed, so a regression in any of
 * them fails loudly rather than silently coming back.
 */
import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
dotenv.config();

const prisma = new PrismaClient();
const BASE = 'http://localhost:4006/api/v1';
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_v1';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  [PASS] ${name}`); passed++; }
  catch (e: any) {
    const d = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    console.log(`  [FAIL] ${name} -- ${d}`); failed++;
  }
}
function assert(cond: boolean, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function unwrap(r: any) { return r.data?.data !== undefined ? r.data.data : r.data; }

async function run() {
  console.log('\n=== AUDIT FIX VERIFICATION ===\n');
  const user = await prisma.user.findFirst({
    where: { status: 'ACTIVE', clientId: 'demo-client', email: 'admin@example.com' }
  });
  if (!user) { console.error('No demo-client admin found'); process.exit(1); }
  const clientId = user.clientId;
  const token = jwt.sign(
    { sub: user.id, clientId, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' },
    JWT_SECRET, { expiresIn: '1h' }
  );
  const api: AxiosInstance = axios.create({
    baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true
  });

  // Pin to MAIN-STORE, the tenant's real stocked location, exactly as run-full-test.ts
  // does. An unordered findFirst() here made this suite depend on which location Postgres
  // happened to return -- so simply creating a location in another test silently pointed
  // it at an empty one and cascaded six false failures (including a bogus "order item was
  // destroyed"). Fall back to whichever location actually holds stock.
  const loc =
    (await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } })) ||
    (await prisma.stockLocation.findFirst({
      where: { clientId, stocks: { some: { quantity: { gt: 3 } } } }
    })) ||
    (await prisma.stockLocation.findFirst({ where: { clientId } }));
  if (!loc) { console.error('No stock location for demo-client'); process.exit(1); }
  const locationId = loc.id;

  // ---- I1: sorting by quantity used to 500 (ProductVariant has no `quantity` column)
  console.log('-- Inventory overview sorting --');
  for (const order of ['asc', 'desc']) {
    await test(`sortBy=quantity&order=${order} returns 200 and is genuinely sorted`, async () => {
      const r = await api.get('/inventory/variants', { params: { sortBy: 'quantity', order, limit: 50 } });
      assert(r.status === 200, `got ${r.status}`);
      const items = unwrap(r).items || [];
      const qtys = items.map((i: any) => i.quantity);
      const sorted = [...qtys].sort((a, b) => (order === 'desc' ? b - a : a - b));
      assert(JSON.stringify(qtys) === JSON.stringify(sorted), `not sorted: ${qtys.slice(0, 8)}`);
    });
  }

  // ---- I5: LOW_STOCK filtered on a hardcoded <=10 while the badge used max(reorderLevel,10)
  await test('LOW_STOCK filter returns only rows this same API badges LOW_STOCK', async () => {
    const r = await api.get('/inventory/variants', { params: { status: 'LOW_STOCK', limit: 100 } });
    assert(r.status === 200, `got ${r.status}`);
    const items = unwrap(r).items || [];
    const mismatched = items.filter((i: any) => i.inventoryStatus !== 'LOW_STOCK');
    assert(mismatched.length === 0, `${mismatched.length} rows badged something else`);
  });

  await test('a variant low only by its reorderLevel (qty > 10) is included', async () => {
    const variant = await prisma.productVariant.findFirst({
      where: { clientId, stocks: { some: {} } }, include: { stocks: true }
    });
    if (!variant || variant.stocks.length === 0) { console.log('     (no stocked variant)'); return; }
    const stock = variant.stocks[0]!;
    const prevReorder = variant.reorderLevel;
    const prevQty = stock.quantity;
    const targetQty = 12; // above the old hardcoded 10, so only reorderLevel can make it "low"
    await prisma.inventoryStock.update({ where: { id: stock.id }, data: { quantity: targetQty } });
    await prisma.productVariant.update({ where: { id: variant.id }, data: { reorderLevel: 25 } });
    try {
      const r = await api.get('/inventory/variants', { params: { status: 'LOW_STOCK', limit: 500 } });
      const items = unwrap(r).items || [];
      const found = items.find((i: any) => i.variantId === variant.id);
      assert(!!found, 'variant with reorderLevel 25 and qty 12 was missing from the LOW_STOCK filter');
      assert(found.inventoryStatus === 'LOW_STOCK', `badged ${found.inventoryStatus}`);
    } finally {
      await prisma.inventoryStock.update({ where: { id: stock.id }, data: { quantity: prevQty } });
      await prisma.productVariant.update({ where: { id: variant.id }, data: { reorderLevel: prevReorder } });
    }
  });

  // ---- I3: the ledger never selected the product relation
  console.log('\n-- Inventory ledger --');
  await test('ledger rows carry variant.product.title', async () => {
    const r = await api.get('/inventory/transactions', { params: { limit: 5 } });
    assert(r.status === 200, `got ${r.status}`);
    const body = unwrap(r);
    const rows = Array.isArray(body) ? body : (body.data || body.items || []);
    if (rows.length === 0) { console.log('     (no transactions yet)'); return; }
    assert(rows[0].variant?.product?.title !== undefined, 'product.title still missing');
  });

  // ---- B1: the customer schema stripped companyName/gstNumber/status
  console.log('\n-- Customer fields --');
  let customerId = '';
  await test('companyName / gstNumber survive a create', async () => {
    const r = await api.post('/customers', {
      name: 'Audit Fix Co', companyName: 'Audit Fix Pvt Ltd',
      gstNumber: '29ABCDE1234F1Z5', phone: '9990001111', status: 'ACTIVE'
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    const c = unwrap(r);
    customerId = c.id;
    assert(c.companyName === 'Audit Fix Pvt Ltd', `companyName=${c.companyName}`);
    assert(c.gstNumber === '29ABCDE1234F1Z5', `gstNumber=${c.gstNumber}`);
  });

  await test('companyName / gstNumber survive an update', async () => {
    const r = await api.patch(`/customers/${customerId}`, {
      name: 'Audit Fix Co', companyName: 'Renamed Pvt Ltd', gstNumber: '27ZYXWV9876K2A1'
    });
    assert(r.status === 200, `got ${r.status}`);
    const c = unwrap(r);
    assert(c.companyName === 'Renamed Pvt Ltd', `companyName=${c.companyName}`);
    assert(c.gstNumber === '27ZYXWV9876K2A1', `gstNumber=${c.gstNumber}`);
  });

  // ---- B2: order-item delete was not scoped to its parent order
  console.log('\n-- Sales order item scoping --');
  const variants = await prisma.productVariant.findMany({
    where: { clientId, stocks: { some: { locationId, quantity: { gt: 3 } } } }, take: 2
  });
  let orderA = '', orderB = '', itemB = '';
  await test('setup: two draft orders, one item on order B', async () => {
    assert(variants.length >= 1, 'need a stocked variant at this location');
    const rA = await api.post('/sales-orders', { customerId, locationId });
    assert(rA.status === 200 || rA.status === 201, `orderA ${rA.status}`);
    orderA = unwrap(rA).id;
    const rB = await api.post('/sales-orders', { customerId, locationId });
    orderB = unwrap(rB).id;
    const iB = await api.post(`/sales-orders/${orderB}/items`, { variantId: variants[0]!.id, quantity: 1 });
    assert(iB.status === 200 || iB.status === 201, `itemB ${iB.status}`);
    itemB = unwrap(iB).id;
  });

  await test('deleting order B’s item through order A is rejected', async () => {
    // Without this guard a failed setup leaves itemB empty, the DELETE hits a different
    // route, and the findUnique below reports "destroyed" for a row that never existed.
    assert(!!orderA && !!itemB, 'setup did not complete -- cannot evaluate scoping');
    const r = await api.delete(`/sales-orders/${orderA}/items/${itemB}`);
    assert(r.status >= 400, `expected rejection, got ${r.status}`);
    const still = await prisma.salesOrderItem.findUnique({ where: { id: itemB } });
    assert(!!still, 'order B’s item was destroyed by a request scoped to order A');
  });

  await test('deleting the item through its own order still works', async () => {
    const r = await api.delete(`/sales-orders/${orderB}/items/${itemB}`);
    assert(r.status === 200 || r.status === 204, `got ${r.status}`);
  });

  // ---- B4: /sales-orders/full dropped sourceSystem, status and the money fields
  console.log('\n-- Storefront/POS order ingestion --');
  const extId = 'EXT-' + Date.now();
  let fullOrderId = '';
  await test('sourceSystem + tax/shipping/discount are persisted', async () => {
    const r = await api.post('/sales-orders/full', {
      customer: { id: customerId }, locationId,
      externalOrderId: extId, sourceSystem: 'STOREFRONT',
      taxAmount: 50, shippingAmount: 30, discountAmount: 10,
      items: [{ variantId: variants[0]!.id, quantity: 1 }]
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    const o = unwrap(r);
    fullOrderId = o.id;
    assert(o.sourceSystem === 'STOREFRONT', `sourceSystem=${o.sourceSystem}`);
    assert(Number(o.taxAmount) === 50, `taxAmount=${o.taxAmount}`);
    assert(Number(o.shippingAmount) === 30, `shippingAmount=${o.shippingAmount}`);
    assert(Number(o.discountAmount) === 10, `discountAmount=${o.discountAmount}`);
  });

  await test('replaying the same externalOrderId is idempotent', async () => {
    const r = await api.post('/sales-orders/full', {
      customer: { id: customerId }, locationId,
      externalOrderId: extId, sourceSystem: 'STOREFRONT',
      taxAmount: 50, shippingAmount: 30, discountAmount: 10,
      items: [{ variantId: variants[0]!.id, quantity: 1 }]
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    assert(unwrap(r).id === fullOrderId, 'a duplicate order was created on replay');
    const count = await prisma.salesOrder.count({
      where: { clientId, externalOrderId: extId, sourceSystem: 'STOREFRONT' }
    });
    assert(count === 1, `${count} orders exist for the same external id`);
  });

  await test('status CONFIRMED actually reserves stock', async () => {
    const r = await api.post('/sales-orders/full', {
      customer: { id: customerId }, locationId,
      externalOrderId: 'EXT-CONF-' + Date.now(), sourceSystem: 'STOREFRONT',
      status: 'CONFIRMED',
      items: [{ variantId: variants[0]!.id, quantity: 1 }]
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    const o = unwrap(r);
    assert(o.status === 'CONFIRMED', `status=${o.status}`);
    const res = await prisma.inventoryReservation.findFirst({
      where: { clientId, salesOrderItemId: o.items[0].id, status: 'ACTIVE' }
    });
    assert(!!res, 'no reservation was created for a CONFIRMED order');
  });

  // ---- B3: inspecting with PENDING bricked the return permanently
  console.log('\n-- Return inspection --');
  await test('PENDING disposition is rejected instead of bricking the return', async () => {
    const ret = await prisma.salesReturn.findFirst({
      where: { clientId, status: { in: ['REQUESTED', 'RECEIVED'] } }, include: { items: true }
    });
    if (!ret || ret.items.length === 0) { console.log('     (no inspectable return in fixtures)'); return; }
    const r = await api.post(`/returns/${ret.id}/inspect`, {
      items: ret.items.map(i => ({ salesReturnItemId: i.id, disposition: 'PENDING' }))
    });
    assert(r.status >= 400, `PENDING was accepted (${r.status})`);
    const after = await prisma.salesReturn.findUnique({ where: { id: ret.id } });
    assert(after!.status === ret.status, `status moved to ${after!.status} anyway`);
  });

  // ---- B7: the x-internal-service-key header used to skip auth without a principal
  console.log('\n-- Auth bypass --');
  await test('service-key header alone cannot reach a tenant route', async () => {
    const key = process.env.INTERNAL_SERVICE_KEY || 'development_secret_key_123';
    const r = await axios.get(`${BASE}/support-tickets`, {
      headers: { 'x-internal-service-key': key }, validateStatus: () => true
    });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  // ---- concurrent stock movements must not be rejected or double-applied
  console.log('\n-- Concurrency --');
  await test('6 simultaneous receipts on one variant all succeed with exact arithmetic', async () => {
    const stock = await prisma.inventoryStock.findFirst({
      where: { clientId, locationId, quantity: { gt: 20 } }
    });
    if (!stock) { console.log('     (no suitable stocked variant)'); return; }

    const before = stock.quantity;
    const N = 6;
    // applyMovement runs at READ COMMITTED behind a FOR UPDATE lock on the variant row.
    // Before that, under SERIALIZABLE with no retry, 3 of these 6 came back as 500s:
    // Postgres resolves a concurrent read-modify-write by aborting a writer (40001), and
    // nothing retried. Two people receiving the same SKU hit this for real.
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        api.post('/inventory/stock-in', {
          variantId: stock.variantId, locationId, quantity: 1,
          unitCost: 100, reason: 'PURCHASE_RECEIPT'
        })
      )
    );

    const rejected = results.filter(r => r.status >= 400);
    // Build the detail lazily: template args are evaluated even when the assertion holds,
    // and JSON.stringify(undefined) returns undefined -- .slice() on which throws, so a
    // PASSING test reported itself as a failure.
    if (rejected.length > 0) {
      const detail = JSON.stringify(rejected[0]?.data ?? {}).slice(0, 160);
      throw new Error(`${rejected.length}/${N} rejected: ${detail}`);
    }

    const after = await prisma.inventoryStock.findUnique({ where: { id: stock.id } });
    assert(after?.quantity === before + N,
      `expected ${before + N}, got ${after?.quantity} -- a write was lost or double-applied`);

    // leave the fixture as we found it
    await prisma.inventoryStock.update({ where: { id: stock.id }, data: { quantity: before } });
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
