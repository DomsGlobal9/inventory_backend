import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
dotenv.config();

const prisma = new PrismaClient();
const BASE = 'http://localhost:4006/api/v1';
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_v1';
const SVC_KEY = process.env.INTERNAL_SERVICE_KEY || 'development_secret_key_123';

let passed = 0, failed = 0, skipped = 0;
const ids: Record<string, string> = {};

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  [PASS] ${name}`); passed++; }
  catch (e: any) {
    const d = e.response?.data ? JSON.stringify(e.response.data).slice(0,300) : e.message;
    console.log(`  [FAIL] ${name} — ${d}`); failed++;
  }
}
async function skip(name: string) { console.log(`  [SKIP] ${name}`); skipped++; }
function assert(cond: boolean, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

function localToken(userId: string, clientId: string) {
  return jwt.sign({ sub: userId, clientId, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, JWT_SECRET, { expiresIn: '1h' });
}

async function run() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  INVENTORY FULL PRODUCTION TEST SUITE            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Pinned to demo-client explicitly — this used to be `findFirst({ where: { status:
  // 'ACTIVE' } })` with no clientId filter, which picks whichever row Postgres
  // happens to return first across ALL tenants (non-deterministic across runs, and
  // in practice it picked up a stale test-client-id user rather than the real dev
  // tenant this whole suite's fixtures assume).
  const TEST_CLIENT_ID = 'demo-client';
  const user = await prisma.user.findFirst({ where: { status: 'ACTIVE', clientId: TEST_CLIENT_ID, email: 'admin@example.com' }, include: { roles: { include: { role: true } } } });
  if (!user) { console.error(`No ACTIVE admin@example.com user found under ${TEST_CLIENT_ID}.`); process.exit(1); }
  const token = localToken(user.id, user.clientId);
  const clientId = user.clientId;

  const api: AxiosInstance = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
  const svcApi: AxiosInstance = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}`, 'x-internal-service-key': SVC_KEY }, validateStatus: () => true });

  // ── 1. AUTH ──
  console.log('\n── 1. AUTHENTICATION ──');
  await test('1.1 No token → 401', async () => { const r = await axios.get(`${BASE}/products`, { validateStatus: () => true }); assert(r.status === 401); });
  await test('1.2 Fake token → 401', async () => { const r = await axios.get(`${BASE}/products`, { headers: { Authorization: 'Bearer fake' }, validateStatus: () => true }); assert(r.status === 401); });
  await test('1.3 Valid token → 200', async () => { const r = await api.get('/products'); assert(r.status === 200, `got ${r.status}`); });
  await test('1.4 Session endpoint', async () => { const r = await api.get('/auth/session'); assert(r.status === 200); });

  // ── 2. LOCATIONS ──
  console.log('\n── 2. LOCATIONS ──');
  await test('2.1 Create location (WAREHOUSE)', async () => { const r = await api.post('/locations', { name: 'Test WH', code: 'TWH-' + Date.now(), type: 'WAREHOUSE' }); assert(r.status === 201); ids.loc1 = r.data.id; });
  await test('2.2 Create location (STORE)', async () => { const r = await api.post('/locations', { name: 'Test ST', code: 'TST-' + Date.now(), type: 'STORE' }); assert(r.status === 201); ids.loc2 = r.data.id; });
  await test('2.3 Get all locations', async () => { const r = await api.get('/locations'); assert(r.status === 200 && Array.isArray(r.data)); });
  await test('2.4 Update location', async () => { const r = await api.put(`/locations/${ids.loc1}`, { name: 'Upd WH', code: 'UWH-' + Date.now(), type: 'WAREHOUSE', active: true }); assert(r.status === 200); });

  // ── 3. PRODUCTS ──
  console.log('\n── 3. PRODUCTS ──');
  await test('3.1 Create product', async () => { const r = await api.post('/products', { title: 'Test Saree ' + Date.now(), category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 2500 }); assert(r.status === 201); ids.prod = r.data.data.id; });
  await test('3.2 Get all products', async () => { const r = await api.get('/products'); assert(r.status === 200); });
  await test('3.3 Get product by ID', async () => { const r = await api.get(`/products/${ids.prod}`); assert(r.status === 200); });
  await test('3.4 Update product', async () => { const r = await api.patch(`/products/${ids.prod}`, { title: 'Updated Saree ' + Date.now() }); assert(r.status === 200); });
  await test('3.5 Pagination', async () => { const r = await api.get('/products?page=1&limit=5&sortBy=createdAt&order=desc'); assert(r.status === 200); });
  await test('3.6 Filter by status', async () => { const r = await api.get('/products?status=ACTIVE'); assert(r.status === 200); });

  // ── 4. VARIANTS ──
  console.log('\n── 4. VARIANTS ──');
  await test('4.1 Create variant', async () => { const r = await api.post(`/products/${ids.prod}/variants`, { sku: 'SKU-' + Date.now(), color: 'Red', size: 'M', price: 2800, costPrice: 1500 }); assert(r.status === 201); ids.var1 = r.data.data?.id || r.data.id; });
  await test('4.2 Get variants by product', async () => { const r = await api.get(`/products/${ids.prod}/variants`); assert(r.status === 200); });
  await test('4.3 Update variant', async () => { const r = await api.patch(`/variants/${ids.var1}`, { price: 2900 }); assert(r.status === 200); });
  await test('4.4 Bulk create variants', async () => {
    const r = await api.post(`/products/${ids.prod}/variants/bulk`, { variants: [
      { sku: 'BLK-A-' + Date.now(), color: 'Blue', size: 'S', price: 2600, costPrice: 1400 },
      { sku: 'BLK-B-' + Date.now(), color: 'Green', size: 'L', price: 2700, costPrice: 1450 }
    ]}); assert(r.status === 200 || r.status === 201);
  });
  await test('4.5 Search variants', async () => { const r = await api.get('/variants/search?q=Red'); assert(r.status === 200); });

  // ── 5. INVENTORY OPS ──
  console.log('\n── 5. INVENTORY OPERATIONS ──');
  const defLoc = await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
  const sLocId = defLoc?.id || ids.loc1;

  await test('5.1 Stock-In', async () => { const r = await api.post('/inventory/stock-in', { variantId: ids.var1, quantity: 50, reason: 'INITIAL_STOCK', locationId: sLocId, unitCost: 1500 }); assert(r.status === 200); });
  await test('5.2 Stock-Out', async () => { const r = await api.post('/inventory/stock-out', { variantId: ids.var1, quantity: 5, reason: 'SALE', locationId: sLocId }); assert(r.status === 200); });
  await test('5.3 Adjustment (+)', async () => { const r = await api.post('/inventory/adjustment', { variantId: ids.var1, quantity: 3, reason: 'MANUAL_ADJUSTMENT', locationId: sLocId }); assert(r.status === 200); });
  await test('5.4 Adjustment (-)', async () => { const r = await api.post('/inventory/adjustment', { variantId: ids.var1, quantity: -2, reason: 'DAMAGE', locationId: sLocId }); assert(r.status === 200); });
  await test('5.5 Get transactions', async () => { const r = await api.get('/inventory/transactions'); assert(r.status === 200); });
  await test('5.6 Get variants', async () => { const r = await api.get('/inventory/variants'); assert(r.status === 200); });
  await test('5.7 Get metadata', async () => { const r = await api.get('/inventory/metadata'); assert(r.status === 200); });

  // ── 6. SUPPLIERS ──
  console.log('\n── 6. SUPPLIERS ──');
  await test('6.1 Create supplier', async () => {
    const r = await api.post('/suppliers', { name: 'Test Supplier ' + Date.now(), email: `s${Date.now()}@test.com`, phone: '9876543210' });
    assert(r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`); ids.sup = r.data.data.id;
  });
  await test('6.2 Get suppliers', async () => { const r = await api.get('/suppliers'); assert(r.status === 200); });
  if (ids.sup) {
    await test('6.3 Get supplier by ID', async () => { const r = await api.get(`/suppliers/${ids.sup}`); assert(r.status === 200); });
    await test('6.4 Update supplier', async () => { const r = await api.put(`/suppliers/${ids.sup}`, { name: 'Updated Supplier', email: `u${Date.now()}@test.com`, phone: '9876543211' }); assert(r.status === 200); });
  } else { await skip('6.3-6.4 (no supplier)'); }

  // ── 7. PURCHASE ORDERS ──
  console.log('\n── 7. PURCHASE ORDERS ──');
  if (ids.sup && ids.var1) {
    await test('7.1 Create PO', async () => {
      const r = await api.post('/purchase-orders', {
        supplierId: ids.sup, expectedDeliveryDate: new Date(Date.now() + 7*86400000).toISOString(),
        items: [{ variantId: ids.var1, orderedQty: 20, unitPrice: 1500 }]
      });
      assert(r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`); ids.po = r.data.data.id;
    });
    await test('7.2 Get POs', async () => { const r = await api.get('/purchase-orders'); assert(r.status === 200); });
    if (ids.po) {
      await test('7.3 Get PO by ID', async () => { const r = await api.get(`/purchase-orders/${ids.po}`); assert(r.status === 200); });
      await test('7.4 Update PO → SENT', async () => { const r = await api.put(`/purchase-orders/${ids.po}/status`, { status: 'SENT' }); assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`); });
      await test('7.5 Receive goods', async () => {
        const po = await api.get(`/purchase-orders/${ids.po}`);
        const itemId = po.data?.data?.items?.[0]?.id;
        if (!itemId) throw new Error('No PO item');
        const r = await api.post(`/purchase-orders/${ids.po}/receive`, { receipts: [{ poItemId: itemId, quantityReceived: 10, locationId: sLocId }] });
        assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
      });
    } else { await skip('7.3-7.5 (no PO)'); }
  } else { await skip('7.x (no supplier/variant)'); }

  // ── 8. CUSTOMERS ──
  console.log('\n── 8. CUSTOMERS ──');
  await test('8.1 Create customer', async () => {
    const r = await api.post('/customers', { name: 'Test Cust', email: `c${Date.now()}@test.com`, phone: '9123456789' });
    if (r.status === 201 || r.status === 200) { ids.cust = r.data.data?.id || r.data.id; }
    assert(r.status === 201 || r.status === 200, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
  });
  await test('8.2 Get customers', async () => { const r = await api.get('/customers'); assert(r.status === 200); });

  // ── 9. SALES ORDERS ──
  console.log('\n── 9. SALES ORDERS ──');
  await test('9.1 Create full order', async () => {
    const r = await api.post('/sales-orders/full', { customer: { id: ids.cust }, locationId: sLocId, items: [{ variantId: ids.var1, quantity: 2 }] });
    if (r.status === 201 || r.status === 200) ids.so = r.data.id;
    assert(r.status === 201 || r.status === 200, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
  });
  await test('9.2 Get orders', async () => { const r = await api.get('/sales-orders'); assert(r.status === 200); });
  if (ids.so) {
    await test('9.3 Get order by ID', async () => { const r = await api.get(`/sales-orders/${ids.so}`); assert(r.status === 200); });
    await test('9.4 Confirm order', async () => { const r = await api.post(`/sales-orders/${ids.so}/confirm`); assert(r.status === 200 || r.status === 400); });
  } else { await skip('9.3-9.4 (no order)'); }

  // ── 10. DASHBOARD & REPORTS ──
  console.log('\n── 10. DASHBOARD & REPORTS ──');
  await test('10.1 Dashboard summary', async () => { const r = await api.get('/dashboard/summary'); assert(r.status === 200); });
  await test('10.2 Inventory value', async () => { const r = await api.get('/reports/inventory-value'); assert(r.status === 200); });
  await test('10.3 Category value', async () => { const r = await api.get('/reports/category-value'); assert(r.status === 200); });
  await test('10.4 Dashboard summary rpt', async () => { const r = await api.get('/reports/dashboard-summary'); assert(r.status === 200); });
  await test('10.5 Inventory summary', async () => { const r = await api.get('/reports/inventory-summary'); assert(r.status === 200); });
  await test('10.6 Recent transactions', async () => { const r = await api.get('/reports/recent-transactions'); assert(r.status === 200); });

  // ── 11. SEARCH ──
  console.log('\n── 11. SEARCH ──');
  await test('11.1 Global search', async () => { const r = await api.get('/search?q=Saree'); assert(r.status === 200); });

  // ── 12. PRODUCT LIFECYCLE ──
  console.log('\n── 12. PRODUCT LIFECYCLE ──');
  const lcr = await api.post('/products', { title: 'Lifecycle Product', category: 'MEN', productType: 'READY_TO_WEAR', basePrice: 500 });
  const lcId = lcr.data?.data?.id;
  if (lcId) {
    await test('12.1 Archive', async () => { assert((await api.post(`/products/${lcId}/archive`)).status === 200); });
    await test('12.2 Restore', async () => { assert((await api.post(`/products/${lcId}/restore`)).status === 200); });
    await test('12.3 Trash', async () => { assert((await api.post(`/products/${lcId}/trash`)).status === 200); });
    await test('12.4 Hard delete', async () => {
      const r = await api.delete(`/products/${lcId}/hard`);
      assert(r.status === 200 || r.status === 400, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
    });
  } else { await skip('12.x (no lifecycle product)'); }

  // ── 13. ALERTS ──
  console.log('\n── 13. INVENTORY ALERTS ──');
  await test('13.1 Get alerts', async () => { const r = await api.get('/inventory/alerts'); assert(r.status === 200); });
  await test('13.2 Mark all read', async () => { const r = await api.patch('/inventory/alerts/read-all'); assert(r.status === 200); });

  // ── 14. STOCK COUNTS ──
  console.log('\n── 14. STOCK COUNTS ──');
  await test('14.1 Create stock count', async () => {
    const r = await api.post('/stock-counts', { name: 'Test Count ' + Date.now(), locationId: sLocId });
    assert(r.status === 201 || r.status === 200, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
    ids.sc = r.data.data?.id || r.data.id;
  });
  await test('14.2 Get stock counts', async () => { const r = await api.get('/stock-counts'); assert(r.status === 200); });

  // ── 15. VALUATION ──
  console.log('\n── 15. VALUATION ──');
  await test('15.1 Reconcile valuation', async () => { const r = await api.post('/inventory/reconcile-valuation?mode=report'); assert(r.status === 200); });

  // ── 16. TRANSACTIONS ──
  console.log('\n── 16. TRANSACTIONS ──');
  await test('16.1 Get transactions', async () => { const r = await api.get('/inventory/transactions'); assert(r.status === 200); });

  // ── 17. GATEWAY AUTH ──
  console.log('\n── 17. GATEWAY AUTH VERIFICATION ──');
  await test('17.1 Gateway JWT structure', async () => {
    const priv = fs.readFileSync(path.resolve(process.cwd(), './dev-keys/gateway-private.pem'), 'utf8');
    const gwToken = jwt.sign({ iss: 'scal_easy_gateway', aud: 'inventory', sub: user.id, clientId }, priv, { algorithm: 'RS256', expiresIn: '60s', keyid: 'gateway-key-01' });
    const d = jwt.decode(gwToken, { complete: true }) as any;
    assert(d.payload.iss === 'scal_easy_gateway');
    assert(d.payload.aud === 'inventory');
    assert(d.header.alg === 'RS256');
  });
  await test('17.2 Service JWT structure', async () => {
    const { ServiceAuth } = await import('../services/service-auth.service');
    const t = ServiceAuth.generateOutboundServiceToken({ audience: 'tryon', scopes: ['tryon.read'], clientId, onBehalfOfUserId: user.id });
    const d = jwt.decode(t, { complete: true }) as any;
    assert(d.payload.iss === 'scal_easy_inventory');
    assert(d.payload.sub === 'inventory-service');
    assert(d.payload.onBehalfOf.userId === user.id);
    assert(d.header.kid === 'inventory-key-01');
  });

  // ── 18. TENANT ISOLATION ──
  console.log('\n── 18. TENANT ISOLATION ──');
  await test('18.1 Fake clientId → 401', async () => {
    const fakeToken = localToken(user.id, 'cl_FAKE');
    const r = await axios.get(`${BASE}/products`, { headers: { Authorization: `Bearer ${fakeToken}` }, validateStatus: () => true });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });
  await test('18.2 Spoofed x-client-id header is ignored (JWT clientId wins)', async () => {
    // tenant.middleware.ts must resolve clientId from the verified JWT only — a
    // client-supplied header must never be able to override it.
    const r = await api.get('/products', { headers: { 'x-client-id': 'client-b' } });
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const leaked = (r.data?.data || []).some((p: any) => p.clientId !== clientId);
    assert(!leaked, 'products from another tenant leaked through a spoofed x-client-id header');
  });
  await test("18.3 Can't read another tenant's product by ID (cross-tenant IDOR)", async () => {
    const otherProduct = await prisma.product.findFirst({ where: { clientId: { not: clientId } } });
    if (!otherProduct) return; // nothing to test against in this DB, not a failure
    const r = await api.get(`/products/${otherProduct.id}`);
    assert([403, 404].includes(r.status), `expected 403/404, got ${r.status}`);
  });

  // ── 19. RBAC PERMISSION BOUNDARIES ──
  // The rest of this suite runs entirely as SUPER_ADMIN, which bypasses every
  // requirePermission check by role name — so it can never catch a broken or
  // mis-keyed permission (e.g. the `return:view` vs `returns:view` casing bug that
  // made the Returns feature unusable for every real role while this exact suite
  // still reported 100% green). This section authenticates as SALES and WAREHOUSE
  // separately and asserts the actual 401/403/allowed boundary per role, plus an
  // unauthenticated pass. Roles/permissions are read from the DB at run time rather
  // than hardcoded, so this stays correct as the permission catalogue evolves —
  // only the *shape* of the matrix (which permission each route requires) is fixed.
  console.log('\n── 19. RBAC PERMISSION BOUNDARIES ──');

  async function tokenFor(email: string): Promise<{ token: string; permissions: string[] } | null> {
    const u = await prisma.user.findUnique({
      where: { clientId_email: { clientId: TEST_CLIENT_ID, email } },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
    });
    if (!u) return null;
    const permissions = Array.from(new Set(u.roles.flatMap(ur => ur.role.permissions.map(rp => rp.permission.key))));
    return { token: localToken(u.id, u.clientId), permissions };
  }

  const salesCtx = await tokenFor('sales@example.com');
  const warehouseCtx = await tokenFor('warehouse@example.com');

  if (!salesCtx || !warehouseCtx) {
    await skip('19.x (sales@example.com / warehouse@example.com test users not found — run seed-rbac.ts first)');
  } else {
    const salesApi: AxiosInstance = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${salesCtx.token}` }, validateStatus: () => true });
    const warehouseApi: AxiosInstance = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${warehouseCtx.token}` }, validateStatus: () => true });

    // Each row: [label, permission key, request fn]. `allowed` is derived from
    // whether SALES/WAREHOUSE's actual current permission set contains the key —
    // so this asserts against ground truth in the DB, not an assumption of what
    // "should" be true, while still being a real regression check: if the
    // permission catalogue or a route's requirePermission() call drifts, this will
    // immediately disagree with what the DB says the role is entitled to.
    type Row = { label: string; permission: string; call: (a: AxiosInstance) => Promise<any> };
    const rows: Row[] = [
      { label: 'GET /products', permission: 'product:view', call: a => a.get('/products') },
      { label: 'POST /products', permission: 'product:create', call: a => a.post('/products', { title: 'RBAC Probe', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1 }) },
      { label: 'POST /inventory/stock-in', permission: 'inventory:receive', call: a => a.post('/inventory/stock-in', { variantId: ids.var1, quantity: 1, reason: 'INITIAL_STOCK', locationId: sLocId }) },
      { label: 'POST /inventory/adjustment', permission: 'inventory:adjust', call: a => a.post('/inventory/adjustment', { variantId: ids.var1, quantity: 1, reason: 'MANUAL_ADJUSTMENT', locationId: sLocId }) },
      { label: 'POST /sales-orders', permission: 'sales_order:create', call: a => a.post('/sales-orders', { customerId: ids.cust }) },
      { label: 'GET /returns', permission: 'return:view', call: a => a.get('/returns') },
      { label: 'POST /returns', permission: 'return:create', call: a => a.post('/returns', { salesOrderId: ids.so || 'nonexistent', items: [] }) },
      { label: 'GET /suppliers', permission: 'supplier:view', call: a => a.get('/suppliers') },
      { label: 'POST /purchase-orders', permission: 'purchase_order:create', call: a => a.post('/purchase-orders', { supplierId: ids.sup || 'nonexistent', items: [] }) },
      { label: 'GET /stock-counts', permission: 'stock_count:view', call: a => a.get('/stock-counts') },
      { label: 'GET /dashboard/summary', permission: 'dashboard:view', call: a => a.get('/dashboard/summary') },
      { label: 'POST /locations', permission: 'admin:locations', call: a => a.post('/locations', { name: 'RBAC Probe', code: 'RBAC-' + Date.now(), type: 'STORE' }) },
    ];

    for (const persona of [
      { name: 'SALES', api: salesApi, permissions: salesCtx.permissions },
      { name: 'WAREHOUSE', api: warehouseApi, permissions: warehouseCtx.permissions },
    ]) {
      for (const row of rows) {
        const shouldBeAllowed = persona.permissions.includes(row.permission);
        await test(`19.${persona.name} ${row.label} [needs ${row.permission}] → ${shouldBeAllowed ? 'allowed' : '403'}`, async () => {
          const r = await row.call(persona.api);
          if (shouldBeAllowed) {
            assert(r.status !== 401 && r.status !== 403, `expected to pass the permission gate, got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
          } else {
            assert(r.status === 403, `expected 403 Forbidden, got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
          }
        });
      }
    }

    // Unauthenticated pass — every one of these must 401 before even reaching the
    // permission check, regardless of what any role is entitled to.
    for (const row of rows) {
      await test(`19.UNAUTH ${row.label} → 401`, async () => {
        const r = await row.call(axios.create({ baseURL: BASE, validateStatus: () => true }));
        assert(r.status === 401, `expected 401, got ${r.status}`);
      });
    }
  }

  // ── CLEANUP ──
  console.log('\n── CLEANUP ──');
  if (ids.loc1) console.log(`  Loc1: ${(await api.delete(`/locations/${ids.loc1}`)).status}`);
  if (ids.loc2) console.log(`  Loc2: ${(await api.delete(`/locations/${ids.loc2}`)).status}`);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${passed} Passed | ${failed} Failed | ${skipped} Skipped`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
