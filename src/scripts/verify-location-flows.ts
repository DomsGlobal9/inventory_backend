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
  const stamp = Date.now();

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
    const i = await api.post(`/sales-orders/${orderId}/items`, { variantId, quantity: 1 });
    assert(i.status === 200 || i.status === 201, `add item ${i.status} ${JSON.stringify(i.data).slice(0,200)}`);
    const unitPrice = Number(unwrap(i).unitPrice);
    assert(unitPrice === 650, `expected 650, got ${unitPrice}`);
  });

  await test('a variant marked unavailable at A cannot be added to an order there', async () => {
    const o = await api.post('/sales-orders', { customerId, locationId: locA });
    const orderId = unwrap(o).id;
    const i = await api.post(`/sales-orders/${orderId}/items`, { variantId, quantity: 1 });
    assert(i.status >= 400, `expected rejection, got ${i.status}`);
  });

  await test('clearing the override falls back to the global selling price', async () => {
    await api.patch(`/products/${productId}/variants/${variantId}/locations/${locB}`, {
      isAvailable: true, priceOverride: null
    });
    const o = await api.post('/sales-orders', { customerId, locationId: locB });
    const orderId = unwrap(o).id;
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

  // ---------------------------------------------------------------- cleanup
  // These locations MUST be removed. Other suites pick a location with an unordered
  // findFirst(), so every location left behind here can silently become "the" location
  // they run against -- an empty one collapses their setup and cascades false failures.
  console.log('\n-- Cleanup --');
  // StockLocation is referenced with onDelete: Restrict from sales_orders, inventory_stocks
  // and inventory_transactions -- correct behaviour (you must not be able to delete a
  // location out from under live orders), but it means cleanup has to unwind in dependency
  // order. Deleting a SalesOrder cascades to its items, their reservations and dispatches.
  const purgeLocations = async (ids: string[]) => {
    if (ids.length === 0) return;
    await prisma.salesOrder.deleteMany({ where: { locationId: { in: ids } } });
    // Every stock movement also writes an outbox row for the webhook dispatcher, and that
    // table carries its own Restrict FK back to the location.
    await prisma.inventoryEvent.deleteMany({ where: { locationId: { in: ids } } });
    await prisma.inventoryTransaction.deleteMany({ where: { locationId: { in: ids } } });
    await prisma.inventoryReservation.deleteMany({ where: { locationId: { in: ids } } });
    await prisma.inventoryStock.deleteMany({ where: { locationId: { in: ids } } });
    await prisma.variantLocationProfile.deleteMany({ where: { locationId: { in: ids } } });
    await prisma.stockLocation.deleteMany({ where: { id: { in: ids } } });
  };

  await test('test locations and fixtures are removed', async () => {
    const locIds = [locA, locB].filter(Boolean);
    await purgeLocations(locIds);
    const leftover = await prisma.stockLocation.count({ where: { clientId, id: { in: locIds } } });
    assert(leftover === 0, `${leftover} test locations left behind`);
  });

  // Sweep locations leaked by earlier runs of this script, before cleanup existed.
  await test('no LocFlow locations leaked from earlier runs', async () => {
    const stale = await prisma.stockLocation.findMany({
      where: { clientId, OR: [{ code: { startsWith: 'LFA-' } }, { code: { startsWith: 'LFB-' } }] },
      select: { id: true }
    });
    const ids = stale.map(l => l.id);
    if (ids.length) {
      await purgeLocations(ids);
      console.log(`     (swept ${ids.length} leaked location(s) from earlier runs)`);
    }
    const remaining = await prisma.stockLocation.count({
      where: { clientId, OR: [{ code: { startsWith: 'LFA-' } }, { code: { startsWith: 'LFB-' } }] }
    });
    assert(remaining === 0, `${remaining} LocFlow locations still present`);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
