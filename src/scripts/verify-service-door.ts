/**
 * Inventory's service door, /api/v1/service (services/service-door). LOCAL ONLY, against the real local server.
 *
 *   1. open: /health and the menu (openapi.json), written from the published list, every route with its permission,
 *      nothing but GET;
 *   2. the pass: none, garbage, an unknown module or key, the wrong audience, longer than 10 minutes, no shop, a
 *      shop not on ScaleEzy -> refused in words;
 *   3. the same as the app: customers, a customer, by phone, points, products, variants, stock, stores -- the
 *      module's answer is the one the app gives the shop's owner, minus cost prices;
 *   4. the walls: another shop's customer is not found; routes NOT on the list (/customers/card, /door-qr,
 *      delete-preview, imports) and every write are 404 naming the menu; the app's own sign-in is not a pass;
 *   5. permissions: a pass without product:view cannot see products (403 in words); "*" and retired or
 *      unknown keys are dropped; a key held to customer:view may not even ask for product:view;
 *   6. a fair share: 600 calls a minute per module and shop, then 429 with Retry-After; another shop is not affected.
 *
 *   DATABASE_URL/DIRECT_URL=local VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-service-door.ts
 *   (4036 must list scaleezy-door-test door-open / door-narrow in TRUSTED_SERVICES_KEYS; keys in dev-keys/door-test*.pem)
 */
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { AREAS } from '../services/service-door/catalogue';
import { COST_FIELDS } from '../middleware/cost-visibility.middleware';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const DOOR = `${BASE}/service`;
const STAMP = Date.now();
const SHOP = `door-${STAMP}`, OTHER = `door-other-${STAMP}`;
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const KEY = fs.readFileSync(process.env.DOOR_KEY ?? 'dev-keys/door-test.pem', 'utf8');

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`); }
};
type Pass = { scope?: string[]; clientId?: string | null; kid?: string; iss?: string; aud?: string; life?: string | number; key?: string };
const pass = (p: Pass = {}) => jwt.sign(
  { sub: 'door-test', scope: p.scope ?? ['customer:view', 'product:view', 'inventory:view'], ...(p.clientId === null ? {} : { clientId: p.clientId ?? SHOP }) },
  p.key ?? KEY, { algorithm: 'RS256', issuer: p.iss ?? 'scaleezy-door-test', audience: p.aud ?? 'inventory', keyid: p.kid ?? 'door-open', expiresIn: p.life ?? '5m' } as any);
async function door(method: string, path: string, p: Pass | string | null = {}, body?: unknown, headers: Record<string, string> = {}) {
  const auth = p === null ? {} : { Authorization: `Bearer ${typeof p === 'string' ? p : pass(p)}` };
  const r = await fetch(`${DOOR}${path}`, { method, headers: { ...auth, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, data: (await r.json().catch(() => null)) as any };
}
let ownerCookie = '';
async function app(path: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: ownerCookie } });
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
}
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 260)}`;
// The app's own list of what counts as cost (never a copy here that could drift from it).
const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (COST_FIELDS.has(k) ? undefined : v)));

async function setup() {
  const roles = await seedRolesForClient(SHOP);
  await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Door Silks', timezone: 'Asia/Kolkata', setupDoneAt: new Date() } as any });
  const owner = await prisma.user.create({ data: { clientId: SHOP, email: `door-owner-${STAMP}@example.invalid`, name: 'Door Owner', password: await AuthService.hashPassword(`x-${STAMP}-${Math.random()}`), status: 'ACTIVE' as any, tourSeenAt: new Date() } as any });
  await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
  ownerCookie = `token=${AuthService.generateToken({ userId: owner.id, clientId: SHOP, sessionVersion: (owner as any).sessionVersion })}`;
  await prisma.user.create({ data: { clientId: OTHER, email: `door-other-${STAMP}@example.invalid`, name: 'Other Owner', password: 'x', status: 'ACTIVE' as any } as any });
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'MAIN', name: 'Main Store', type: 'STORE' } });
  const p1 = `+9196${String(STAMP).slice(-6)}01`;
  const lakshmi = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `DR-${STAMP}-1`, name: 'Lakshmi Door', phone: p1 } as any });
  await prisma.customer.create({ data: { clientId: SHOP, customerCode: `DR-${STAMP}-2`, name: 'Ravi Door', phone: `+9196${String(STAMP).slice(-6)}02` } as any });
  const theirs = await prisma.customer.create({ data: { clientId: OTHER, customerCode: `DR-${STAMP}-3`, name: 'Not Yours', phone: `+9196${String(STAMP).slice(-6)}03` } as any });
  const product = await prisma.product.create({ data: { clientId: SHOP, productCode: `DR-${STAMP}`, slug: `dr-${STAMP}`, title: 'Kanchi silk saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 9000, status: 'ACTIVE' as any } as any });
  await prisma.productVariant.create({ data: { productId: product.id, clientId: SHOP, variantCode: `DR-${STAMP}-RED`, sku: `DR-${STAMP}-RED`, costPrice: 500 } as any });
  return { store, lakshmi, theirs, product, p1 };
}

(async () => {
  try {
    const s = await setup();

    console.log('\n1. OPEN: HEALTH AND THE MENU');
    let r = await door('GET', '/health', null);
    check('/health answers without a pass', r.status === 200 && r.data?.service === 'inventory' && r.data?.api === 'service', brief(r));
    r = await door('GET', '/openapi.json', null);
    const paths = r.data?.paths ?? {};
    const listed = AREAS.flatMap(a => a.routes.map(x => `${a.at}${x.path === '/' ? '' : x.path}`.replace(/:([A-Za-z]+)/g, '{$1}')));
    const ops = Object.values(paths).flatMap((p: any) => Object.keys(p));
    check('the menu lists every published route, each with the permission it needs', r.status === 200 && listed.every(p => paths[p]?.get?.['x-required-scope']), { missing: listed.filter(p => !paths[p]) });
    check('...and nothing but GET (read only for now)', ops.length > 0 && ops.every(m => m === 'get'), ops);
    check('...and says how to sign a pass (RS256, kid, aud "inventory", 10 minutes, clientId, scope)', /RS256/.test(r.data?.info?.description) && /10 minutes/.test(r.data?.info?.description) && /clientId/.test(r.data?.info?.description));

    console.log('\n2. THE PASS');
    r = await door('GET', '/customers?page=1', null);
    check('no pass: 401', r.status === 401, brief(r));
    r = await door('GET', '/customers?page=1', 'not.a.token');
    check('garbage: 401', r.status === 401, brief(r));
    r = await door('GET', '/customers?page=1', { iss: 'scaleezy-nobody' });
    check('a module Inventory does not know: 401', r.status === 401 && /Unknown issuer/.test(r.data?.message), brief(r));
    r = await door('GET', '/customers?page=1', { kid: 'door-gone' });
    check('a key Inventory does not know: 401', r.status === 401, brief(r));
    r = await door('GET', '/customers?page=1', { aud: 'scaleezy-crm' });
    check('a pass for another module (aud scaleezy-crm): 401', r.status === 401, brief(r));
    const { privateKey: stranger } = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    r = await door('GET', '/customers?page=1', { key: stranger as unknown as string });
    check('signed with somebody else\'s key under this module\'s name: 401', r.status === 401, brief(r));
    r = await door('GET', '/customers?page=1', { life: '15m' });
    check('a pass lasting 15 minutes: 401, at most 10', r.status === 401 && /at most 10 minutes/.test(r.data?.message), brief(r));
    r = await door('GET', '/customers?page=1', { clientId: null });
    check('no shop named: 400 in words', r.status === 400 && /clientId/.test(r.data?.message), brief(r));
    r = await door('GET', '/customers?page=1', { clientId: `no-such-shop-${STAMP}` });
    check('a shop not on ScaleEzy: 404 in words', r.status === 404 && /not on ScaleEzy/.test(r.data?.message), brief(r));
    r = await door('GET', '/customers?page=1', null, undefined, { cookie: ownerCookie });
    check('the app\'s own sign-in is not a pass: 401', r.status === 401, brief(r));

    console.log('\n3. THE SAME AS THE APP');
    for (const [what, path] of [
      ['the customer list', '/customers?page=1&limit=50'],
      ['one customer', `/customers/${s.lakshmi.id}`],
      ['a customer by phone', `/customers/by-phone/${encodeURIComponent(s.p1)}`],
      ['points rules', '/loyalty/settings'],
      ['a customer\'s points', `/loyalty/customers/${s.lakshmi.id}`],
      ['the product list', '/products?page=1&limit=20'],
      ['one product', `/products/${s.product.id}`],
      ['a product\'s variants', `/products/${s.product.id}/variants`],
      ['a product\'s photos', `/products/${s.product.id}/images`],
      ['variant search', '/variants/search?q=Kanchi'],
      ['stock', '/stock/variants'],
      ['stores', '/locations']
    ] as const) {
      const viaDoor = await door('GET', path);
      const viaApp = await app(path.replace(/^\/stock/, '/inventory'));
      check(`${what}: 200, and exactly what the app gives the owner (cost prices aside)`, viaDoor.status === 200 && viaApp.status === 200 && JSON.stringify(strip(viaDoor.data)) === JSON.stringify(strip(viaApp.data)), { door: brief(viaDoor), app: brief(viaApp) });
    }
    const vApp = JSON.stringify((await app(`/products/${s.product.id}/variants`)).data);
    const vDoor = JSON.stringify((await door('GET', `/products/${s.product.id}/variants`)).data);
    check('cost prices: the owner sees ₹500, a module never does', /"costPrice":"?500/.test(vApp) && !/costPrice/.test(vDoor), { app: vApp.slice(0, 200), door: vDoor.slice(0, 200) });
    r = await door('GET', `/customers/by-phone/${encodeURIComponent(`+9196${String(STAMP).slice(-6)}77`)}`);
    check('a number nobody has: 200 with null, like the app', r.status === 200 && r.data?.data === null, brief(r));
    r = await door('GET', '/customers/by-phone/hello');
    check('not a phone number: 400 in the app\'s words', r.status === 400 && typeof r.data?.message === 'string', brief(r));

    console.log('\n4. THE WALLS');
    r = await door('GET', `/customers/${s.theirs.id}`);
    check('another shop\'s customer, asked for by id: not found (never their details)', r.status === 404 && !JSON.stringify(r.data).includes('Not Yours'), brief(r));
    for (const path of ['/customers/card', '/customers/door-qr', '/customers/checkins', `/customers/${s.lakshmi.id}/delete-preview`, '/customers/imports', '/products/try-ons/most-tried', `/products/${s.product.id}/price-impact`, '/stock/transactions', '/campaigns', '/users', '/nothing']) {
      r = await door('GET', path);
      check(`not on the list, GET ${path}: 404 naming the menu`, r.status === 404 && /openapi\.json/.test(r.data?.message), brief(r));
    }
    for (const [m, path] of [['POST', '/customers'], ['PATCH', `/customers/${s.lakshmi.id}`], ['DELETE', `/customers/${s.lakshmi.id}`], ['POST', '/products'], ['PUT', '/locations/x']] as const) {
      r = await door(m, path, {}, { name: 'X' });
      check(`a write, ${m} ${path}: 404 (read only), nothing changed`, r.status === 404, brief(r));
    }
    check('...Lakshmi is untouched', (await prisma.customer.findUnique({ where: { id: s.lakshmi.id } }))?.name === 'Lakshmi Door');

    console.log('\n5. PERMISSIONS');
    r = await door('GET', '/products?page=1', { scope: ['customer:view'] });
    check('a pass without product:view: products 403, saying which permission', r.status === 403 && /product:view/.test(r.data?.message), brief(r));
    r = await door('GET', '/customers?page=1', { scope: ['*'] });
    check('a pass asking for "*" (everything): dropped, so customers 403', r.status === 403, brief(r));
    r = await door('GET', '/customers?page=1', { scope: ['campaign:view', 'admin:locations', 'customer:delete', 'made:up'] });
    check('retired, admin, owner and made-up keys: dropped, so customers 403', r.status === 403, brief(r));
    r = await door('GET', '/customers?page=1', { kid: 'door-narrow', scope: ['customer:view'] });
    check('a key held to customer:view: customers 200', r.status === 200, brief(r));
    r = await door('GET', '/customers?page=1', { kid: 'door-narrow', scope: ['customer:view', 'product:view'] });
    check('...but it may not even ask for product:view: the whole pass refused, 403 in words', r.status === 403 && /may not ask for product:view/.test(r.data?.message), brief(r));
    r = await door('GET', '/locations', { scope: ['customer:view'] });
    check('stores need inventory:view too (the door checks, even where the app\'s route does not)', r.status === 403 && /inventory:view/.test(r.data?.message), brief(r));

    console.log('\n6. A FAIR SHARE');
    let first429: any = null, n = 0;
    const p = pass({ clientId: OTHER, scope: ['inventory:view'] });
    while (n < 700 && !first429) {
      const batch = await Promise.all(Array.from({ length: 50 }, () => door('GET', '/locations', p)));
      n += 50;
      first429 = batch.find(x => x.status === 429) ?? null;
    }
    check('more than 600 calls quickly for one shop: 429 in words, with Retry-After', !!first429 && /600 a minute/.test(first429.data?.message) && first429.headers.get('retry-after') === '5', { n, first: first429 && brief(first429) });
    r = await door('GET', '/locations', { scope: ['inventory:view'] });
    check('...while the same module for ANOTHER shop is not held up', r.status === 200, brief(r));
  } catch (e: any) { failures.push(`crashed: ${e?.message}`); console.error(e); }
  finally {
    for (const id of [SHOP, OTHER]) {
      await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
    }
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  }
})();
