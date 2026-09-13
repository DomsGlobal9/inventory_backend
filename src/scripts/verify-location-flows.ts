/**
 * Location flow verification.
 *
 * Locations touch stock, pricing and availability, so this walks the whole surface:
 * per-location stock scoping, availability gating, price overrides in order pricing,
 * transfers, and location CRUD permissions.
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
  console.log('\n=== LOCATION FLOW VERIFICATION ===\n');
  const user = await prisma.user.findFirst({
    where: { status: 'ACTIVE', clientId: 'demo-client', email: 'admin@example.com' }
  });
  if (!user) { console.error('No demo-client admin'); process.exit(1); }
  const clientId = user.clientId;
  const token = jwt.sign(
    { sub: user.id, clientId, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' },
    JWT_SECRET, { expiresIn: '1h' }
  );
  const api: AxiosInstance = axios.create({
    baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true
  });

  // ---------------------------------------------------------------- setup
  let locA = '', locB = '', productId = '', variantId = '', customerId = '';
  const orderIds: string[] = [];
  const stamp = Date.now();
  const runStartedAt = new Date();

  /*
   * Everything this run creates is removed in the finally below, whether the checks pass, fail or
   * throw. It used to remove only the two locations, and only when it reached the end: every run
   * left a customer and a product behind on demo-client -- 37 of each by the time anyone counted --
   * and later suites (stock counts among them) picked the products up as if they were real stock.
   */
  try {

  console.log('-- Location CRUD --');
  await test('create two locations', async () => {
    const a = await api.post('/locations', { name: `LocFlow A ${stamp}`, code: `LFA-${stamp}`, type: 'WAREHOUSE' });
    assert(a.status === 201, `A ${a.status}`);
    locA = unwrap(a).id;
    const b = await api.post('/locations', { name: `LocFlow B ${stamp}`, code: `LFB-${stamp}`, type: 'STORE' });
    assert(b.status === 201, `B ${b.status}`);
    locB = unwrap(b).id;
  });

  await test('duplicate location code is rejected', async () => {
    const r = await api.post('/locations', { name: 'dupe', code: `LFA-${stamp}`, type: 'STORE' });
    assert(r.status >= 400, `expected rejection, got ${r.status}`);
  });

  await test('rename a location', async () => {
    const r = await api.put(`/locations/${locA}`, { name: `LocFlow A renamed ${stamp}` });
    assert(r.status === 200, `got ${r.status}`);
  });

  await test('GET /locations is readable (app-shell reference data)', async () => {
    const r = await api.get('/locations');
    assert(r.status === 200, `got ${r.status}`);
    const list = unwrap(r);
    assert(Array.isArray(list) && list.length >= 2, 'expected the two new locations');
  });

  // ---------------------------------------------------------------- stock scoping
  console.log('\n-- Per-location stock --');
  await test('setup: a product + variant to move around', async () => {
    const p = await api.post('/products', {
      title: `LocFlow Product ${stamp}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 500
    });
    assert(p.status === 200 || p.status === 201, `product ${p.status}`);
    productId = unwrap(p).id;
    const v = await api.post(`/products/${productId}/variants`, {
      sku: `LOCFLOW-${stamp}`, size: 'M', colorName: 'Blue', reorderLevel: 5
    });
    assert(v.status === 200 || v.status === 201, `variant ${v.status}`);
    variantId = unwrap(v).id;
  });

  await test('stock received at A is visible at A only', async () => {
    const r = await api.post('/inventory/stock-in', {
      variantId, locationId: locA, quantity: 40, unitCost: 100, reason: 'PURCHASE_RECEIPT'
    });
    assert(r.status === 200 || r.status === 201, `stock-in ${r.status}`);

    const atA = await prisma.inventoryStock.findFirst({ where: { variantId, locationId: locA } });
    const atB = await prisma.inventoryStock.findFirst({ where: { variantId, locationId: locB } });
    assert(atA?.quantity === 40, `A has ${atA?.quantity}`);
    assert(!atB || atB.quantity === 0, `B should be empty, has ${atB?.quantity}`);
  });

  await test('inventory overview scoped to A shows 40, scoped to B shows 0', async () => {
    const rA = await api.get('/inventory/variants', { params: { search: `LOCFLOW-${stamp}`, locationId: locA } });
    const rB = await api.get('/inventory/variants', { params: { search: `LOCFLOW-${stamp}`, locationId: locB } });
    const a = (unwrap(rA).items || []).find((i: any) => i.variantId === variantId);
    const b = (unwrap(rB).items || []).find((i: any) => i.variantId === variantId);
    assert(a?.quantity === 40, `A overview shows ${a?.quantity}`);
    assert(b === undefined || b.quantity === 0, `B overview shows ${b?.quantity}`);
  });

  // ---------------------------------------------------------------- transfers
  console.log('\n-- Transfers --');
  await test('transfer 15 units A -> B moves stock on both sides', async () => {
    const r = await api.post('/inventory-transfers', {
      originLocationId: locA, destinationLocationId: locB, notes: 'locflow test',
      items: [{ variantId, quantity: 15 }]
    });
    assert(r.status === 200 || r.status === 201, `transfer ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
    const atA = await prisma.inventoryStock.findFirst({ where: { variantId, locationId: locA } });
    const atB = await prisma.inventoryStock.findFirst({ where: { variantId, locationId: locB } });
    assert(atA?.quantity === 25, `A should be 25, is ${atA?.quantity}`);
    assert(atB?.quantity === 15, `B should be 15, is ${atB?.quantity}`);
  });

  await test('transferring more than is on hand is rejected', async () => {
    const r = await api.post('/inventory-transfers', {
      originLocationId: locB, destinationLocationId: locA,
      items: [{ variantId, quantity: 9999 }]
    });
    assert(r.status >= 400, `expected rejection, got ${r.status}`);
    const atB = await prisma.inventoryStock.findFirst({ where: { variantId, locationId: locB } });
    assert(atB?.quantity === 15, `B disturbed: ${atB?.quantity}`);
  });

  await test('transfer to the same location is rejected', async () => {
    const r = await api.post('/inventory-transfers', {
      originLocationId: locA, destinationLocationId: locA,
      items: [{ variantId, quantity: 1 }]
    });
    assert(r.status >= 400, `expected rejection, got ${r.status}`);
  });

  // ---------------------------------------------------------------- price override
  console.log('\n-- Location price override + availability --');
  await test('set a price override at B and mark A unavailable', async () => {
    const sp = await api.patch(`/variants/${variantId}`, { sellingPrice: 700 });
    assert(sp.status === 200, `sellingPrice ${sp.status} ${JSON.stringify(sp.data).slice(0,200)}`);
    const rB = await api.patch(`/products/${productId}/variants/${variantId}/locations/${locB}`, {
      isAvailable: true, priceOverride: 650
    });
    assert(rB.status === 200, `B profile ${rB.status}`);
    const rA = await api.patch(`/products/${productId}/variants/${variantId}/locations/${locA}`, {
      isAvailable: false, priceOverride: null
    });
    assert(rA.status === 200, `A profile ${rA.status}`);
  });

  await test('an order at B prices the line at the override (650), not the global 700', async () => {
    const c = await api.post('/customers', { name: `LocFlow Cust ${stamp}` });
    customerId = unwrap(c).id;
    const o = await api.post('/sales-orders', { customerId, locationId: locB });
    const orderId = unwrap(o).id;
    if (orderId) orderIds.push(orderId);
    const i = await api.post(`/sales-orders/${orderId}/items`, { variantId, quantity: 1 });
    assert(i.status === 200 || i.status === 201, `add item ${i.status} ${JSON.stringify(i.data).slice(0,200)}`);
    const unitPrice = Number(unwrap(i).unitPrice);
    assert(unitPrice === 650, `expected 650, got ${unitPrice}`);
  });

  await test('a variant marked unavailable at A cannot be added to an order there', async () => {
    const o = await api.post('/sales-orders', { customerId, locationId: locA });
    const orderId = unwrap(o).id;
    if (orderId) orderIds.push(orderId);
    const i = await api.post(`/sales-orders/${orderId}/items`, { variantId, quantity: 1 });
    assert(i.status >= 400, `expected rejection, got ${i.status}`);
  });

  await test('clearing the override falls back to the global selling price', async () => {
    await api.patch(`/products/${productId}/variants/${variantId}/locations/${locB}`, {
      isAvailable: true, priceOverride: null
    });
    const o = await api.post('/sales-orders', { customerId, locationId: locB });
    const orderId = unwrap(o).id;
    if (orderId) orderIds.push(orderId);
    const i = await api.post(`/sales-orders/${orderId}/items`, { variantId, quantity: 1 });
    assert(i.status === 200 || i.status === 201, `add item ${i.status}`);
    const unitPrice = Number(unwrap(i).unitPrice);
    assert(unitPrice === 700, `expected global 700, got ${unitPrice}`);
  });

  // ---------------------------------------------------------------- cross-tenant
  console.log('\n-- Isolation --');
  await test("another tenant's location cannot be used for stock-in", async () => {
    const foreign = await prisma.stockLocation.findFirst({ where: { clientId: { not: clientId } } });
    if (!foreign) { console.log('     (no other-tenant location)'); return; }
    const r = await api.post('/inventory/stock-in', {
      variantId, locationId: foreign.id, quantity: 1, reason: 'PURCHASE_RECEIPT'
    });
    assert(r.status >= 400, `expected rejection, got ${r.status}`);
  });

  await test('a location holding stock cannot be silently deleted', async () => {
    const r = await api.delete(`/locations/${locA}`);
    const atA = await prisma.inventoryStock.findFirst({ where: { variantId, locationId: locA } });
    if (r.status < 400) {
      assert(!atA || atA.quantity === 0, `location deleted while holding ${atA?.quantity} units`);
    }
  });

  } catch (e: any) {
    // A throw outside any single check still counts as a failure, and still reaches the cleanup.
    console.log(`  [FAIL] the run stopped early -- ${e?.message ?? e}`); failed++;
  } finally {
    // ---------------------------------------------------------------- cleanup
    // All of it MUST be removed. Other suites pick a location with an unordered findFirst(), so
    // every location left behind here can silently become "the" location they run against -- an
    // empty one collapses their setup and cascades false failures. A leftover product is swept
    // into every stock count another suite starts, and a leftover customer clutters the shop.
    console.log('\n-- Cleanup --');
    const locIds = [locA, locB].filter(Boolean);
    try {
      await purge(clientId, {
        locationIds: locIds, productIds: [productId].filter(Boolean), customerIds: [customerId].filter(Boolean), orderIds
      });
      /*
       * The audit rows this run wrote. Ones about creating something carry "n/a" rather than the
       * new record's id (the audit logger does not capture it), so they cannot be found by id --
       * only as what this script's user did between the start of the run and now.
       */
      await prisma.auditLog.deleteMany({ where: { clientId, userId: user.id, createdAt: { gte: runStartedAt } } });
    } catch (e: any) {
      console.log(`  [FAIL] cleanup threw -- ${e?.message ?? e}`); failed++;
    }

    await test('test locations, product, customer, orders and their audit rows are removed', async () => {
      const [locs, products, variants, customers, orders, audit] = await Promise.all([
        prisma.stockLocation.count({ where: { clientId, id: { in: locIds } } }),
        prisma.product.count({ where: { clientId, title: `LocFlow Product ${stamp}` } }),
        prisma.productVariant.count({ where: { clientId, sku: `LOCFLOW-${stamp}` } }),
        prisma.customer.count({ where: { clientId, name: `LocFlow Cust ${stamp}` } }),
        prisma.salesOrder.count({ where: { clientId, id: { in: orderIds } } }),
        prisma.auditLog.count({ where: { clientId, userId: user.id, createdAt: { gte: runStartedAt } } })
      ]);
      assert(locs + products + variants + customers + orders + audit === 0,
        `left behind: ${locs} location(s), ${products} product(s), ${variants} item(s), ${customers} customer(s), ${orders} order(s), ${audit} audit row(s)`);
    });

    // What earlier runs of this script leaked, before its cleanup covered everything.
    await test('nothing leaked by earlier runs that can safely go is left', async () => {
      const swept = await sweepEarlierRuns(clientId);
      if (swept.removed) console.log(`     (swept ${swept.removed} left by earlier runs)`);
      if (swept.kept) console.log(`     (kept ${swept.kept} left by earlier runs -- other records still name them)`);
      const remaining = await prisma.stockLocation.count({
        where: { clientId, OR: [{ code: { startsWith: 'LFA-' } }, { code: { startsWith: 'LFB-' } }] }
      });
      assert(remaining === 0, `${remaining} LocFlow locations still present`);
    });
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * Remove what a run created, in the order the foreign keys allow.
 *
 * StockLocation is referenced with onDelete: Restrict from sales_orders, inventory_stocks and
 * inventory_transactions -- correct behaviour (you must not be able to delete a location out from
 * under live orders) -- and ProductVariant likewise from stock, order items and transfers. So
 * orders go first (deleting a SalesOrder cascades to its items, their reservations and
 * dispatches), then stock rows and movements, then the things they pointed at.
 */
async function purge(
  clientId: string,
  ids: { locationIds: string[]; productIds: string[]; customerIds: string[]; orderIds: string[] }
) {
  const { locationIds, productIds, customerIds, orderIds } = ids;
  const variantIds = productIds.length
    ? (await prisma.productVariant.findMany({ where: { clientId, productId: { in: productIds } }, select: { id: true } })).map(v => v.id)
    : [];
  const atThese = { OR: [{ locationId: { in: locationIds } }, { variantId: { in: variantIds } }] };

  await prisma.salesOrder.deleteMany({
    where: { clientId, OR: [{ id: { in: orderIds } }, { locationId: { in: locationIds } }, { customerId: { in: customerIds } }] }
  });
  // Every stock movement also writes an outbox row for the webhook dispatcher, and that table
  // carries its own Restrict FK back to the location and the item.
  await prisma.inventoryEvent.deleteMany({ where: atThese });
  await prisma.inventoryAlert.deleteMany({ where: { clientId, ...atThese } });
  await prisma.inventoryTransaction.deleteMany({ where: atThese });
  await prisma.inventoryReservation.deleteMany({ where: atThese });
  await prisma.inventoryStock.deleteMany({ where: atThese });
  await prisma.variantLocationProfile.deleteMany({ where: atThese });
  await prisma.inventoryTransfer.deleteMany({
    where: { clientId, OR: [{ variantId: { in: variantIds } }, { fromLocationId: { in: locationIds } }, { toLocationId: { in: locationIds } }] }
  });
  await prisma.storefrontEvent.deleteMany({ where: { clientId, variantId: { in: variantIds } } });
  // Variants and images go with their product (onDelete: Cascade).
  await prisma.product.deleteMany({ where: { clientId, id: { in: productIds } } });
  await prisma.stockLocation.deleteMany({ where: { clientId, id: { in: locationIds } } });
  await prisma.customer.deleteMany({ where: { clientId, id: { in: customerIds } } });
  // And the audit trail of test records that no longer exist.
  const entityIds = [...locationIds, ...productIds, ...variantIds, ...customerIds, ...orderIds];
  if (entityIds.length) await prisma.auditLog.deleteMany({ where: { clientId, entityId: { in: entityIds } } });
}

/**
 * What earlier runs left behind, removed only where nothing else still names it.
 *
 * A leftover location, customer or product from this script is fixture data. But another suite may
 * since have made it part of something -- a stock count lists every item in the shop, and an order
 * or a quote names a customer -- and deleting it then would quietly rewrite that record. Those are
 * kept and counted, not forced.
 */
async function sweepEarlierRuns(clientId: string) {
  const locationIds = (await prisma.stockLocation.findMany({
    where: { clientId, OR: [{ code: { startsWith: 'LFA-' } }, { code: { startsWith: 'LFB-' } }] }, select: { id: true }
  })).map(l => l.id);

  const customers = await prisma.customer.findMany({
    where: { clientId, name: { startsWith: 'LocFlow Cust ' } },
    select: { id: true, _count: { select: { salesOrders: true } } }
  });
  const customerIds: string[] = [];
  for (const c of customers) {
    if (c._count.salesOrders > 0) continue;
    const named = await prisma.pricingQuote.count({ where: { customerId: c.id } })
      + await prisma.offerRedemption.count({ where: { customerId: c.id } });
    if (named === 0) customerIds.push(c.id);
  }

  const products = await prisma.product.findMany({
    where: { clientId, title: { startsWith: 'LocFlow Product ' }, variants: { every: { sku: { startsWith: 'LOCFLOW-' } } } },
    select: { id: true, variants: { select: { id: true } } }
  });
  const productIds: string[] = [];
  for (const p of products) {
    const w = { variantId: { in: p.variants.map(v => v.id) } };
    const named = await prisma.stockCountItem.count({ where: w }) + await prisma.purchaseOrderItem.count({ where: w })
      + await prisma.salesOrderItem.count({ where: w }) + await prisma.inventoryTransaction.count({ where: w })
      + await prisma.supplierProduct.count({ where: w }) + await prisma.shopifyIdMap.count({ where: w })
      + await prisma.inventoryStock.count({ where: { ...w, quantity: { not: 0 } } });
    if (named === 0) productIds.push(p.id);
  }

  if (locationIds.length || customerIds.length || productIds.length) {
    await purge(clientId, { locationIds, productIds, customerIds, orderIds: [] });
  }
  const removed = [
    locationIds.length && `${locationIds.length} location(s)`,
    customerIds.length && `${customerIds.length} customer(s)`,
    productIds.length && `${productIds.length} product(s)`
  ].filter(Boolean).join(', ');
  const kept = (customers.length - customerIds.length) + (products.length - productIds.length);
  return { removed, kept };
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
