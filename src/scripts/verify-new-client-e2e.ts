/**
 * Full end-to-end walkthrough for a BRAND-NEW client.
 *
 * Onboards a real tenant through the Platform Console, then exercises every module the
 * sidebar exposes. The point is not just "does each endpoint return 200" -- after every
 * mutation it re-reads the OTHER screens that should have changed (dashboard, inventory
 * overview, ledger, alerts, platform console) and asserts they actually did. Cross-screen
 * staleness is the class of bug a per-endpoint test never catches.
 */
import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
dotenv.config();

const prisma = new PrismaClient();
const BASE = 'http://localhost:4006/api/v1';
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_v1';
// Platform-admin tokens use a deliberately distinct iss/aud pair from client tokens
// (see AuthService.generatePlatformAdminToken) but the SAME signing secret.

let passed = 0, failed = 0;
const fails: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  [PASS] ${name}`); passed++; }
  catch (e: any) {
    const d = e.response?.data ? JSON.stringify(e.response.data).slice(0, 250) : e.message;
    console.log(`  [FAIL] ${name}\n         -> ${d}`); failed++; fails.push(name);
  }
}
function section(t: string) { console.log(`\n${'-'.repeat(4)} ${t} ${'-'.repeat(4)}`); }
function assert(c: boolean, m = 'assertion failed') { if (!c) throw new Error(m); }
function unwrap(r: any) { return r.data?.data !== undefined ? r.data.data : r.data; }
const num = (v: any) => Number(v ?? 0);

async function run() {
  console.log('\n================ NEW CLIENT END-TO-END ================');
  const stamp = Date.now();
  const company = `E2E Boutique ${stamp}`;
  const adminEmail = `e2e${stamp}@example.com`;

  // ---- platform admin session -------------------------------------------------
  const pa = await prisma.platformAdmin.findFirst({ where: { status: 'ACTIVE' } });
  if (!pa) { console.error('No ACTIVE platform admin'); process.exit(1); }
  const paToken = jwt.sign(
    { sub: pa.id, iss: 'scal_easy_platform_admin', aud: 'scal_easy_platform_console' },
    JWT_SECRET, { expiresIn: '2h' }
  );
  const admin: AxiosInstance = axios.create({
    baseURL: BASE, headers: { Cookie: `platform_admin_token=${paToken}` }, validateStatus: () => true
  });

  // =============================================================== ONBOARDING
  section('PLATFORM CONSOLE: onboarding a new client');
  let clientId = '', tempPassword = '', adminUserId = '';

  await test('platform admin session is valid', async () => {
    const r = await admin.get('/auth/admin/session');
    assert(r.status === 200, `got ${r.status} -- platform admin auth failed`);
  });

  await test('onboard client returns clientId + generated credentials', async () => {
    // Onboarding is POST /admin/clients (see platform-admin.routes.ts), not /admin/onboard.
    const r = await admin.post('/admin/clients', {
      companyName: company, adminName: 'E2E Owner', adminEmail
    });
    assert(r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 250)}`);
    const d = unwrap(r);
    clientId = d.clientId || d.client?.clientId;
    tempPassword = d.password || d.tempPassword || d.credentials?.password;
    assert(!!clientId, `no clientId in response: ${JSON.stringify(d).slice(0, 200)}`);
    assert(!!tempPassword, `no password returned -- admin could never sign in`);
  });

  await test('the new client appears in the console client list', async () => {
    const r = await admin.get('/admin/clients');
    assert(r.status === 200, `got ${r.status}`);
    const list = unwrap(r);
    assert(Array.isArray(list) && list.some((c: any) => c.clientId === clientId),
      'newly onboarded client missing from /admin/clients');
  });

  await test('client overview loads and reports exactly 1 user', async () => {
    const r = await admin.get(`/admin/clients/${clientId}`);
    assert(r.status === 200, `got ${r.status}`);
    const d = unwrap(r);
    assert(d.userCount === 1, `userCount=${d.userCount}`);
    assert(d.onboardingStatus === 'NOT_STARTED', `onboardingStatus=${d.onboardingStatus}`);
    adminUserId = d.users?.[0]?.id;
    assert(!!adminUserId, 'no admin user returned');
  });

  // =============================================================== LOGIN
  section('CLIENT SIDE: first login with the issued credentials');
  const api: AxiosInstance = axios.create({ baseURL: BASE, validateStatus: () => true });
  let token = '';

  await test('the issued credentials actually work', async () => {
    const r = await api.post('/auth/login', { email: adminEmail, password: tempPassword });
    assert(r.status === 200, `login got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    const body = r.data;
    const u = body.data?.user || body.user;
    assert(!!u, 'no user in login response');
    // The login payload deliberately omits clientId -- /auth/session exposes it as
    // client.id instead. Assert on identity + role, then confirm the tenant via session.
    assert(u.email === adminEmail, `email=${u.email}`);
    assert((u.roles || []).includes('SUPER_ADMIN'), `roles=${JSON.stringify(u.roles)}`);
  });

  await test('wrong password is rejected', async () => {
    const r = await api.post('/auth/login', { email: adminEmail, password: 'definitely-wrong' });
    assert(r.status === 401, `got ${r.status}`);
  });

  // Use a bearer token for the rest (cookie jar not needed for a script).
  token = jwt.sign(
    { sub: adminUserId, clientId, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' },
    JWT_SECRET, { expiresIn: '2h' }
  );
  const c: AxiosInstance = axios.create({
    baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true
  });

  // =============================================================== SIDEBAR: baseline
  section('SIDEBAR: every screen loads for a brand-new tenant (empty states)');
  const screens: [string, string][] = [
    ['Dashboard', '/dashboard/summary'],
    ['Products', '/products'],
    ['Inventory overview', '/inventory/variants'],
    ['Inventory ledger', '/inventory/transactions'],
    ['Alerts', '/inventory/alerts'],
    ['Transfers (locations)', '/locations'],
    ['Purchase Orders', '/purchase-orders'],
    ['Suppliers', '/suppliers'],
    ['Customers', '/customers'],
    ['Orders', '/sales-orders'],
    ['Returns', '/returns'],
    ['Stock counts', '/stock-counts'],
    ['Reports/snapshots', '/reports/snapshots'],
    ['Team & Users', '/team/members'],
    ['Support tickets', '/support-tickets'],
    ['Catalog config', '/catalog/config'],
  ];
  for (const [label, path] of screens) {
    await test(`${label} loads (${path})`, async () => {
      const r = await c.get(path);
      assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 160)}`);
    });
  }

  await test('catalog defaults were seeded at onboarding (sizes/colors exist)', async () => {
    const r = await c.get('/catalog/config');
    const g = unwrap(r);
    const total = Object.values(g || {}).reduce((a: number, v: any) => a + (v?.length || 0), 0);
    assert(total > 0, 'no catalog items -- a new client cannot create a product');
  });

  // =============================================================== LOCATIONS
  section('LOCATIONS');
  let locMain = '', locStore = '';
  await test('create warehouse + store', async () => {
    const a = await c.post('/locations', { name: 'E2E Warehouse', code: `E2EW-${stamp}`, type: 'WAREHOUSE' });
    assert(a.status === 201, `warehouse ${a.status}`); locMain = unwrap(a).id;
    const b = await c.post('/locations', { name: 'E2E Store', code: `E2ES-${stamp}`, type: 'STORE' });
    assert(b.status === 201, `store ${b.status}`); locStore = unwrap(b).id;
  });

  // =============================================================== PRODUCTS
  section('PRODUCTS + VARIANTS');
  let productId = '', v1 = '', v2 = '';
  await test('create a product', async () => {
    const r = await c.post('/products', {
      title: `E2E Saree ${stamp}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    productId = unwrap(r).id;
  });

  await test('PROPAGATION: product count on the client Products list went 0 -> 1', async () => {
    const r = await c.get('/products');
    const body = unwrap(r);
    const items = Array.isArray(body) ? body : (body.items || body.data || []);
    assert(items.some((p: any) => p.id === productId), 'new product missing from /products');
  });

  await test('PROPAGATION: platform console onboardingStatus moved off NOT_STARTED', async () => {
    const r = await admin.get(`/admin/clients/${clientId}`);
    const d = unwrap(r);
    assert(d.productCount >= 1, `console still reports productCount=${d.productCount}`);
    assert(d.onboardingStatus !== 'NOT_STARTED', `still NOT_STARTED`);
  });

  await test('create two variants', async () => {
    const a = await c.post(`/products/${productId}/variants`, {
      sku: `E2E-${stamp}-RED-M`, size: 'M', colorName: 'Red', reorderLevel: 5
    });
    assert(a.status === 200 || a.status === 201, `v1 ${a.status}`); v1 = unwrap(a).id;
    const b = await c.post(`/products/${productId}/variants`, {
      sku: `E2E-${stamp}-BLU-L`, size: 'L', colorName: 'Blue', reorderLevel: 5
    });
    assert(b.status === 200 || b.status === 201, `v2 ${b.status}`); v2 = unwrap(b).id;
  });

  await test('set cost + selling price on v1 (the pricing flow)', async () => {
    const r = await c.patch(`/variants/${v1}`, { costPrice: 350, sellingPrice: 490 });
    assert(r.status === 200, `got ${r.status}`);
    const d = unwrap(r);
    assert(num(d.sellingPrice) === 490, `sellingPrice=${d.sellingPrice}`);
    assert(num(d.costPrice) === 350, `costPrice=${d.costPrice}`);
  });

  // =============================================================== STOCK
  section('INVENTORY: receive / issue / adjust + propagation');
  await test('stock-in 100 @ warehouse with unit cost 300', async () => {
    const r = await c.post('/inventory/stock-in', {
      variantId: v1, locationId: locMain, quantity: 100, unitCost: 300, reason: 'INITIAL_STOCK'
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
  });

  await test('PROPAGATION: inventory overview shows 100 and WAC became 300', async () => {
    const r = await c.get('/inventory/variants', { params: { search: `E2E-${stamp}-RED-M` } });
    const item = (unwrap(r).items || []).find((i: any) => i.variantId === v1);
    assert(!!item, 'variant missing from inventory overview');
    assert(item.quantity === 100, `quantity=${item.quantity}`);
    assert(num(item.averageCost) === 300, `averageCost=${item.averageCost}`);
  });

  await test('PROPAGATION: ledger recorded the movement with balances', async () => {
    const r = await c.get('/inventory/transactions', { params: { limit: 20 } });
    const body = unwrap(r);
    const rows = Array.isArray(body) ? body : (body.data || body.items || []);
    const tx = rows.find((t: any) => t.variantId === v1);
    assert(!!tx, 'no ledger row for the stock-in');
    assert(tx.balanceBefore === 0 && tx.balanceAfter === 100,
      `balances ${tx.balanceBefore}->${tx.balanceAfter}`);
    assert(tx.variant?.product?.title, 'ledger row missing product title');
  });

  await test('PROPAGATION: dashboard inventory value reflects 100 x 300 = 30000', async () => {
    const r = await c.get('/dashboard/summary');
    const d = unwrap(r);
    assert(num(d.inventoryValue) >= 30000, `inventoryValue=${d.inventoryValue}`);
  });

  await test('WAC blends on a second receipt at a different cost', async () => {
    const r = await c.post('/inventory/stock-in', {
      variantId: v1, locationId: locMain, quantity: 100, unitCost: 400, reason: 'PURCHASE_RECEIPT'
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    const chk = await c.get('/inventory/variants', { params: { search: `E2E-${stamp}-RED-M` } });
    const item = (unwrap(chk).items || []).find((i: any) => i.variantId === v1);
    assert(item.quantity === 200, `quantity=${item.quantity}`);
    assert(num(item.averageCost) === 350, `expected blended 350, got ${item.averageCost}`);
  });

  await test('issue 10 reduces stock', async () => {
    const r = await c.post('/inventory/stock-out', {
      variantId: v1, locationId: locMain, quantity: 10, reason: 'SALE'
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    const chk = await c.get('/inventory/variants', { params: { search: `E2E-${stamp}-RED-M` } });
    const item = (unwrap(chk).items || []).find((i: any) => i.variantId === v1);
    assert(item.quantity === 190, `quantity=${item.quantity}`);
  });

  await test('issuing more than on hand is refused and changes nothing', async () => {
    const r = await c.post('/inventory/stock-out', {
      variantId: v1, locationId: locMain, quantity: 99999, reason: 'SALE'
    });
    assert(r.status >= 400, `expected rejection, got ${r.status}`);
    const chk = await c.get('/inventory/variants', { params: { search: `E2E-${stamp}-RED-M` } });
    const item = (unwrap(chk).items || []).find((i: any) => i.variantId === v1);
    assert(item.quantity === 190, `stock disturbed: ${item.quantity}`);
  });

  await test('negative adjustment works', async () => {
    const r = await c.post('/inventory/adjustment', {
      variantId: v1, locationId: locMain, quantity: -5, reason: 'DAMAGE'
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    const chk = await c.get('/inventory/variants', { params: { search: `E2E-${stamp}-RED-M` } });
    const item = (unwrap(chk).items || []).find((i: any) => i.variantId === v1);
    assert(item.quantity === 185, `quantity=${item.quantity}`);
  });

  // =============================================================== LOW STOCK ALERT
  section('ALERTS: low stock fires and surfaces');
  await test('dropping v1 below reorderLevel raises a low-stock alert', async () => {
    await c.post('/inventory/adjustment', {
      variantId: v1, locationId: locMain, quantity: -(185 - 2), reason: 'MANUAL_ADJUSTMENT'
    });
    const r = await c.get('/inventory/alerts');
    const body = unwrap(r);
    const list = body.alerts || body.items || (Array.isArray(body) ? body : []);
    assert(list.length > 0, 'no alert raised after dropping below reorder level');
  });

  await test('PROPAGATION: dashboard criticalStockItems picked it up', async () => {
    // /dashboard/summary is dashboardService.getSummary, which exposes
    // criticalStockItems/openPurchaseOrders -- NOT the lowStockCount/openPoValue shape
    // that reportService.getDashboardSummary returns for the snapshot engine.
    const r = await c.get('/dashboard/summary');
    const d = unwrap(r);
    // criticalStockItems is a COUNT here, not the array its name suggests.
    const n = Array.isArray(d.criticalStockItems) ? d.criticalStockItems.length : num(d.criticalStockItems);
    assert(n >= 1, `criticalStockItems=${JSON.stringify(d.criticalStockItems)?.slice(0,80)}`);
  });

  await test('PROPAGATION: platform console health shows the alert for this client', async () => {
    const r = await admin.get(`/admin/clients/${clientId}`);
    assert(num(unwrap(r).activeAlertCount) >= 1, `activeAlertCount=${unwrap(r).activeAlertCount}`);
  });

  // restore stock for later flows
  await c.post('/inventory/stock-in', {
    variantId: v1, locationId: locMain, quantity: 200, unitCost: 350, reason: 'PURCHASE_RECEIPT'
  });

  // =============================================================== TRANSFERS
  section('TRANSFERS');
  await test('transfer 50 warehouse -> store moves both sides', async () => {
    const r = await c.post('/inventory-transfers', {
      originLocationId: locMain, destinationLocationId: locStore,
      items: [{ variantId: v1, quantity: 50 }]
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
    const atW = await prisma.inventoryStock.findFirst({ where: { variantId: v1, locationId: locMain } });
    const atS = await prisma.inventoryStock.findFirst({ where: { variantId: v1, locationId: locStore } });
    assert(atS?.quantity === 50, `store=${atS?.quantity}`);
    assert(num(atW?.quantity) === 152, `warehouse=${atW?.quantity} (expected 152)`);
  });

  await test('PROPAGATION: overview scoped to store shows 50, warehouse shows 152', async () => {
    const rs = await c.get('/inventory/variants', { params: { search: `E2E-${stamp}-RED-M`, locationId: locStore } });
    const rw = await c.get('/inventory/variants', { params: { search: `E2E-${stamp}-RED-M`, locationId: locMain } });
    const s = (unwrap(rs).items || []).find((i: any) => i.variantId === v1);
    const w = (unwrap(rw).items || []).find((i: any) => i.variantId === v1);
    assert(s?.quantity === 50, `store view=${s?.quantity}`);
    assert(w?.quantity === 152, `warehouse view=${w?.quantity}`);
  });

  // =============================================================== SUPPLIERS + PO
  section('SUPPLIERS + PURCHASE ORDERS');
  let supplierId = '', poId = '', poItemId = '';
  await test('create a supplier', async () => {
    const r = await c.post('/suppliers', {
      name: `E2E Supplier ${stamp}`, email: `sup${stamp}@example.com`, phone: '9876500000'
    });
    assert(r.status === 201, `got ${r.status}`); supplierId = unwrap(r).id;
  });

  await test('create a purchase order', async () => {
    const r = await c.post('/purchase-orders', {
      supplierId, locationId: locMain,
      items: [{ variantId: v2, sku: `E2E-${stamp}-BLU-L`, orderedQty: 40, unitPrice: 500 }]
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,250)}`);
    const d = unwrap(r); poId = d.id; poItemId = d.items?.[0]?.id;
    assert(!!poItemId, 'PO created without items');
  });

  await test('PROPAGATION: dashboard openPurchaseOrders reflects the open PO', async () => {
    const r = await c.get('/dashboard/summary');
    assert(num(unwrap(r).openPurchaseOrders) >= 1, `openPurchaseOrders=${unwrap(r).openPurchaseOrders}`);
  });

  await test('receive the PO -> stock, WAC and lastPurchaseCost all update', async () => {
    const r = await c.post(`/purchase-orders/${poId}/receive`, {
      receipts: [{ poItemId, quantityReceived: 40, locationId: locMain }]
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,250)}`);
    const stock = await prisma.inventoryStock.findFirst({ where: { variantId: v2, locationId: locMain } });
    assert(stock?.quantity === 40, `v2 stock=${stock?.quantity}`);
    const variant = await prisma.productVariant.findUnique({ where: { id: v2 } });
    assert(num(variant?.averageCost) === 500, `averageCost=${variant?.averageCost}`);
    assert(num(variant?.lastPurchaseCost) === 500, `lastPurchaseCost=${variant?.lastPurchaseCost}`);
  });

  await test('PROPAGATION: PO status moved to RECEIVED', async () => {
    const r = await c.get(`/purchase-orders/${poId}`);
    assert(unwrap(r).status === 'RECEIVED', `status=${unwrap(r).status}`);
  });

  await test('receiving more than ordered is refused', async () => {
    const r = await c.post(`/purchase-orders/${poId}/receive`, {
      receipts: [{ poItemId, quantityReceived: 10, locationId: locMain }]
    });
    assert(r.status >= 400, `expected rejection, got ${r.status}`);
  });

  // =============================================================== CUSTOMERS + ORDERS
  section('CUSTOMERS + SALES ORDERS (ingested from storefront/POS)');
  let customerId = '', orderId = '', orderItemId = '';
  await test('create a customer with all fields', async () => {
    const r = await c.post('/customers', {
      name: `E2E Customer ${stamp}`, companyName: 'E2E Retail Pvt Ltd',
      gstNumber: '29AAAAA0000A1Z5', phone: '9000011111', status: 'ACTIVE'
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    const d = unwrap(r); customerId = d.id;
    assert(d.companyName === 'E2E Retail Pvt Ltd', `companyName=${d.companyName}`);
    assert(d.gstNumber === '29AAAAA0000A1Z5', `gstNumber=${d.gstNumber}`);
  });

  await test('storefront order lands CONFIRMED and reserves stock', async () => {
    const before = await prisma.inventoryStock.findFirst({ where: { variantId: v1, locationId: locStore } });
    const r = await c.post('/sales-orders/full', {
      customer: { id: customerId }, locationId: locStore,
      externalOrderId: `EXT-${stamp}`, sourceSystem: 'STOREFRONT', status: 'CONFIRMED',
      taxAmount: 50, shippingAmount: 25, discountAmount: 10,
      items: [{ variantId: v1, quantity: 4 }]
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,250)}`);
    const d = unwrap(r); orderId = d.id; orderItemId = d.items?.[0]?.id;
    assert(d.status === 'CONFIRMED', `status=${d.status}`);
    assert(num(d.taxAmount) === 50 && num(d.shippingAmount) === 25 && num(d.discountAmount) === 10,
      'tax/shipping/discount not persisted');
    assert(num(d.items[0].unitPrice) === 490, `unitPrice=${d.items[0].unitPrice} (expected variant price 490)`);
    const after = await prisma.inventoryStock.findFirst({ where: { variantId: v1, locationId: locStore } });
    assert(num(after?.reservedQty) === num(before?.reservedQty) + 4,
      `reservedQty ${before?.reservedQty} -> ${after?.reservedQty}`);
    assert(after?.quantity === before?.quantity, 'physical stock changed on reserve (should not)');
  });

  await test('replaying the same external order is idempotent', async () => {
    const r = await c.post('/sales-orders/full', {
      customer: { id: customerId }, locationId: locStore,
      externalOrderId: `EXT-${stamp}`, sourceSystem: 'STOREFRONT', status: 'CONFIRMED',
      items: [{ variantId: v1, quantity: 4 }]
    });
    assert(unwrap(r).id === orderId, 'duplicate order created on replay');
    const n = await prisma.salesOrder.count({ where: { clientId, externalOrderId: `EXT-${stamp}` } });
    assert(n === 1, `${n} orders for the same external id`);
  });

  await test('dispatch 2 of 4 -> physical stock drops, order PARTIALLY_DISPATCHED', async () => {
    const before = await prisma.inventoryStock.findFirst({ where: { variantId: v1, locationId: locStore } });
    const r = await c.post('/dispatches', {
      salesOrderId: orderId, items: [{ salesOrderItemId: orderItemId, quantity: 2 }]
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,250)}`);
    const after = await prisma.inventoryStock.findFirst({ where: { variantId: v1, locationId: locStore } });
    assert(num(after?.quantity) === num(before?.quantity) - 2,
      `physical ${before?.quantity} -> ${after?.quantity}`);
    assert(num(after?.reservedQty) === num(before?.reservedQty) - 2,
      `reserved ${before?.reservedQty} -> ${after?.reservedQty}`);
    const o = await prisma.salesOrder.findUnique({ where: { id: orderId }, include: { items: true } });
    assert(o?.items[0].fulfilledQty === 2, `fulfilledQty=${o?.items[0].fulfilledQty}`);
    assert(o?.status === 'PARTIALLY_DISPATCHED', `order status=${o?.status}`);
  });

  await test('over-dispatching the remainder is refused', async () => {
    const r = await c.post('/dispatches', {
      salesOrderId: orderId, items: [{ salesOrderItemId: orderItemId, quantity: 99 }]
    });
    assert(r.status >= 400, `expected rejection, got ${r.status}`);
  });

  await test('PROPAGATION: order appears in the client Orders list', async () => {
    const r = await c.get('/sales-orders');
    const body = unwrap(r);
    const list = Array.isArray(body) ? body : (body.items || body.data || []);
    assert(list.some((o: any) => o.id === orderId), 'order missing from list');
  });

  // =============================================================== STOCK COUNT
  section('STOCK COUNT / AUDIT');
  let countId = '';
  await test('create and start a stock count', async () => {
    const r = await c.post('/stock-counts', { name: `E2E Count ${stamp}`, locationId: locMain, createdBy: 'E2E Owner' });
    assert(r.status === 200 || r.status === 201, `got ${r.status}`);
    countId = unwrap(r).id;
    const s = await c.post(`/stock-counts/${countId}/start`);
    assert(s.status === 200 || s.status === 201, `start ${s.status}`);
  });

  await test('a started count snapshots the tenant\'s variants', async () => {
    const r = await c.get(`/stock-counts/${countId}`);
    const items = unwrap(r).items || [];
    assert(items.length >= 2, `only ${items.length} items snapshotted`);
  });

  // =============================================================== TEAM
  section('TEAM & USERS');
  let staffId = '';
  await test('admin creates a staff member with a set password', async () => {
    const roles = await c.get('/team/roles');
    assert(roles.status === 200, `roles ${roles.status}`);
    const rb = unwrap(roles);
    const list = Array.isArray(rb) ? rb : (rb.roles || rb.items || []);
    const wh = list.find((x: any) => x.name === 'WAREHOUSE');
    assert(!!wh, `no WAREHOUSE role seeded: ${JSON.stringify(list.map((x:any)=>x.name))}`);
    const r = await c.post('/team/members', {
      name: 'E2E Staff', email: `staff${stamp}@example.com`,
      customPassword: 'StaffPass123!', roleId: wh.id
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,250)}`);
    const d = unwrap(r);
    staffId = d.id || d.user?.id || d.member?.id;
    assert(!!staffId, `no user id returned: ${JSON.stringify(d).slice(0,150)}`);
  });

  await test('PROPAGATION: staff shows in team list and in the platform console', async () => {
    const t = await c.get('/team/members');
    const body = unwrap(t);
    const list = Array.isArray(body) ? body : (body.members || body.items || []);
    assert(list.length >= 2, `team list has ${list.length}`);
    const a = await admin.get(`/admin/clients/${clientId}`);
    assert(num(unwrap(a).userCount) >= 2, `console userCount=${unwrap(a).userCount}`);
  });

  await test('the staff member can log in with the password the admin set', async () => {
    const r = await api.post('/auth/login', { email: `staff${stamp}@example.com`, password: 'StaffPass123!' });
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
  });

  await test('WAREHOUSE staff is denied an admin-only action (RBAC holds)', async () => {
    const staffToken = jwt.sign(
      { sub: staffId, clientId, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' },
      JWT_SECRET, { expiresIn: '1h' }
    );
    const s = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${staffToken}` }, validateStatus: () => true });
    const denied = await s.post('/locations', { name: 'nope', code: `X-${stamp}`, type: 'STORE' });
    assert(denied.status === 403, `expected 403, got ${denied.status}`);
    const allowed = await s.get('/inventory/variants');
    assert(allowed.status === 200, `warehouse should read inventory, got ${allowed.status}`);
  });

  // =============================================================== SUPPORT
  section('SUPPORT TICKETS');
  let ticketId = '';
  await test('client raises a support ticket', async () => {
    const r = await c.post('/support-tickets', {
      subject: `E2E ticket ${stamp}`, description: 'End-to-end check', category: 'OTHER', priority: 'NORMAL'
    });
    assert(r.status === 200 || r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
    ticketId = unwrap(r).id;
  });

  // The endpoint has no Zod schema and no tenant/permission middleware, so an invalid
  // enum reaches Prisma and surfaces as a 500. Not reachable from the current UI (its
  // dropdowns only offer valid values) but any other caller gets an opaque 500.
  await test('KNOWN GAP: invalid priority should 4xx, not 500', async () => {
    const r = await c.post('/support-tickets', {
      subject: 'bad priority', description: 'x', category: 'OTHER', priority: 'MEDIUM'
    });
    assert(r.status >= 400 && r.status < 500, `got ${r.status} (500 = unvalidated input reaching Prisma)`);
  });

  await test('PROPAGATION: the ticket is visible in the Platform Console', async () => {
    const r = await admin.get('/admin/support-tickets');
    const body = unwrap(r);
    const list = Array.isArray(body) ? body : (body.items || body.tickets || []);
    assert(list.some((t: any) => t.id === ticketId), 'ticket missing from console');
  });

  // =============================================================== ERRORS
  section('CLIENT ERROR REPORTING');
  await test('a client-side error report reaches the console', async () => {
    const r = await axios.post(`${BASE}/client-errors`, {
      clientId, message: `E2E synthetic error ${stamp}`,
      stack: 'at e2e', url: '/products', userAgent: 'e2e-script'
    }, { validateStatus: () => true });
    assert(r.status === 200 || r.status === 201, `report got ${r.status}`);
    const list = await admin.get('/admin/client-errors');
    const body = unwrap(list);
    const rows = Array.isArray(body) ? body : (body.items || body.errors || []);
    assert(rows.some((e: any) => (e.message || '').includes(String(stamp))), 'error missing from console');
  });

  // =============================================================== IMPERSONATION
  section('PLATFORM CONSOLE: impersonation + audit');
  await test('assume the client session', async () => {
    const r = await admin.post(`/admin/clients/${clientId}/assume`);
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
    const d = unwrap(r);
    assert(!!d.sessionId, 'no sessionId');
    assert(d.assumedAsFullAccess === true, 'should have full access (client has a SUPER_ADMIN)');
  });

  await test('PROPAGATION: impersonation is recorded in the console audit log', async () => {
    const r = await admin.get('/admin/audit-log');
    const body = unwrap(r);
    const rows = Array.isArray(body) ? body : (body.items || body.logs || []);
    assert(rows.some((x: any) => x.clientId === clientId), 'no audit row for this client');
  });

  await test('cross-tenant read is impossible with this client token', async () => {
    const other = await prisma.productVariant.findFirst({
      where: { clientId: { not: clientId } }, select: { id: true, productId: true }
    });
    if (!other) { console.log('     (no other tenant)'); return; }
    const r = await c.get(`/products/${other.productId}`);
    assert(r.status === 404 || r.status === 403, `got ${r.status} -- cross-tenant leak`);
  });

  // =============================================================== SUMMARY
  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (fails.length) { console.log('Failures:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log(`\nTest tenant left in place for inspection: clientId = ${clientId}`);
  console.log(`  admin login: ${adminEmail}`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
