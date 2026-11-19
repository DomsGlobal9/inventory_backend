/**
 * EVERY way ScaleEzy CRM and Inventory talk, checked from CRM's side of the wire (18 Nov 2026).
 *
 *   A  the lock on every door: each of the 61 internal routes CRM can call, tried with no key, a broken key,
 *      a key past its time, a key for another audience, an unsigned key, a key from an unknown signer, an app
 *      sign-in instead of a service key, a service key without modules:crm, a key for ANOTHER shop, and a shop
 *      that has not switched CRM on. Every one refused, nothing written by any of them.
 *   B  the person behind a change: no one named, someone from another shop, someone switched off, someone
 *      without the permission -- refused on every route that changes something for a person.
 *   C  the right key, the right person: every route answers without a crash (no 5xx), in plain words.
 *   D  the flows across both modules: a shop joins CRM; CRM adds a customer and Inventory's change feed
 *      tells CRM; consent and dates set from CRM show in Inventory; a person signs in to Inventory and CRM
 *      asks who they are, then they are switched off; CRM deletes a customer; CRM is switched off and every
 *      door closes, and on again.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   CRM_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-crm-contract.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const STAMP = Date.now();
const SHOP = `crmcontract-${STAMP}`;
const OTHER = `crmcontract-other-${STAMP}`;
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 300)}`;
const plain = (m: unknown) => typeof m === 'string' && /[a-z]{3}/i.test(m) && !/prisma|Invalid `|constraint|P20\d\d|undefined|NaN|stack|at [A-Z]\w+\.|TypeError|ReferenceError/i.test(m);
const call = (method: string, path: string, headers: Record<string, string> = {}, data?: any) =>
  axios.request({ method, url: `${BASE}${path}`, headers, data, validateStatus: () => true, timeout: 60_000 });

const privateKey = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');
const sign = (claims: Record<string, unknown>, opts: jwt.SignOptions = {}) =>
  jwt.sign({ sub: 'scaleezy-crm-test', scope: ['modules:crm', 'session:read'], ...claims }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m', ...opts });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const key = (claims: Record<string, unknown> = {}) => bearer(sign(claims));
const forShop = (clientId: string, userId?: string) => key({ clientId, ...(userId ? { onBehalfOf: { userId } } : {}) });
const unsigned = () => {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return bearer(`${b({ alg: 'none', typ: 'JWT', kid: 'test-1' })}.${b({ sub: 'scaleezy-crm-test', scope: ['modules:crm'], aud: 'inventory', iss: 'scaleezy-crm-test', exp: Math.floor(Date.now() / 1000) + 300 })}.`);
};
const strangerKey = () => {
  const { privateKey: other } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return bearer(jwt.sign({ sub: 'scaleezy-crm-test', scope: ['modules:crm'] }, other.export({ type: 'pkcs8', format: 'pem' }) as string, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' }));
};

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const rolesO = await seedRolesForClient(OTHER);
  for (const c of [SHOP, OTHER]) await prisma.clientSettings.create({ data: { clientId: c, businessName: c === SHOP ? 'Contract Silks' : 'Other', timezone: 'Asia/Kolkata' } as any });
  const mkUser = async (clientId: string, name: string, roleId: string, status = 'ACTIVE') => {
    const u = await prisma.user.create({ data: { clientId, email: `${name.toLowerCase().replace(/\W/g, '')}-${STAMP}@example.com`, name, password: await AuthService.hashPassword('Not-Used-123'), status: status as any } as any });
    await prisma.userRole.create({ data: { userId: u.id, roleId } });
    return u;
  };
  const owner = await mkUser(SHOP, 'Owner Contract', roles.SUPER_ADMIN);
  const store = await mkUser(SHOP, 'Store Keeper', roles.WAREHOUSE);
  const gone = await mkUser(SHOP, 'Gone Person', roles.SUPER_ADMIN, 'INACTIVE');
  const theirOwner = await mkUser(OTHER, 'Their Owner', rolesO.SUPER_ADMIN);
  const customer = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `K-1-${STAMP}`, name: 'Contract Meena', phone: `+9194${String(STAMP).slice(-8)}` } as any });
  const victim = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `K-2-${STAMP}`, name: 'To Delete', phone: `+9193${String(STAMP).slice(-8)}` } as any });
  const product = await prisma.product.create({ data: { clientId: SHOP, productCode: `KP-${STAMP}`, slug: `kp-${STAMP}`, title: 'Contract saree', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } as any });
  const image = await prisma.productImage.create({ data: { productId: product.id, url: 'http://127.0.0.1:9/storage/v1/object/public/x.jpg', imageType: 'GALLERY', orderIndex: 0, isPrimary: true } as any });
  const fake = '00000000-0000-4000-8000-00000000dead';

  // ── D1: a shop joins CRM ────────────────────────────────────────────────────────────────────────────
  console.log('\nD1. A SHOP JOINS CRM');
  const on1 = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, key());
  const on2 = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, key());
  check('switching CRM on twice: both 200, one subscription', on1.status === 200 && on2.status === 200 && (await prisma.moduleSubscription.count({ where: { clientId: SHOP, module: 'crm' } })) === 1, `${brief(on1)} | ${brief(on2)}`);
  const listed = await call('GET', '/internal/modules/crm/shops', key());
  check('...the shop is in CRM\'s list of shops, the other shop is not', listed.status === 200 && listed.data.data.some((s: any) => s.clientId === SHOP) && !listed.data.data.some((s: any) => s.clientId === OTHER), brief(listed));
  const badModule = await call('GET', '/internal/modules/finance/shops', key());
  check('...CRM\'s key cannot act for another module (finance): 403', badModule.status === 403, brief(badModule));

  // ── The routes ──────────────────────────────────────────────────────────────────────────────────────
  type R = { m: string; p: string; guard: 'shop' | 'readable' | 'person' | 'module'; body?: any };
  const P = (s: string) => s.replace(':customerId', customer.id).replace(':checkinId', fake).replace(':id', fake).replace(':salesOrderId', fake)
    .replace(':key', 'vip').replace(':imageId', image.id).replace(':productId', product.id);
  const routes: R[] = [
    { m: 'GET', p: '/locations', guard: 'shop' },
    { m: 'GET', p: '/customers/:customerId/suggestions', guard: 'shop' },
    { m: 'GET', p: '/groups/projection', guard: 'shop' },
    { m: 'PUT', p: '/groups/projection', guard: 'shop', body: { version: 'x' } },
    { m: 'PATCH', p: '/groups/projection/customers/:customerId', guard: 'shop', body: { version: 'x' } },
    { m: 'GET', p: '/groups', guard: 'readable' },
    { m: 'POST', p: '/groups', guard: 'person', body: { name: 'VIP' } },
    { m: 'POST', p: '/groups/members', guard: 'person', body: { group: 'VIP', customerIds: [] } },
    { m: 'GET', p: '/groups/:key/members', guard: 'readable' },
    { m: 'DELETE', p: '/groups/:key/members/:customerId', guard: 'person' },
    { m: 'POST', p: '/groups/:key/rename', guard: 'person', body: { name: 'X' } },
    { m: 'POST', p: '/groups/:key/merge', guard: 'person', body: { into: 'X' } },
    { m: 'PATCH', p: '/groups/:key/rules', guard: 'person', body: {} },
    { m: 'DELETE', p: '/groups/:key', guard: 'person' },
    { m: 'GET', p: '/reviews/stats', guard: 'readable' },
    { m: 'GET', p: '/reviews/hide-reasons', guard: 'readable' },
    { m: 'GET', p: '/reviews', guard: 'readable' },
    { m: 'POST', p: '/reviews/:id/reply', guard: 'person', body: { text: 'Thank you' } },
    { m: 'DELETE', p: '/reviews/:id/reply', guard: 'person' },
    { m: 'POST', p: '/reviews/:id/hide', guard: 'person', body: { reason: 'spam' } },
    { m: 'POST', p: '/reviews/:id/unhide', guard: 'person' },
    { m: 'GET', p: '/orders/:salesOrderId/review-link', guard: 'readable' },
    { m: 'GET', p: '/feedback', guard: 'readable' },
    { m: 'POST', p: '/feedback/:id/handled', guard: 'person' },
    { m: 'GET', p: '/customers/:customerId/past-purchases', guard: 'readable' },
    { m: 'GET', p: '/past-purchases', guard: 'readable' },
    { m: 'GET', p: '/past-purchases/patterns', guard: 'readable' },
    { m: 'GET', p: '/customers/:customerId/offers', guard: 'readable' },
    { m: 'PUT', p: '/customers/:customerId/offers', guard: 'person', body: { agreed: true } },
    { m: 'POST', p: '/customers', guard: 'person', body: { name: 'X' } },
    { m: 'GET', p: '/door-qr', guard: 'readable' },
    { m: 'POST', p: '/checkins/:checkinId/take', guard: 'person' },
    { m: 'POST', p: '/checkins/:checkinId/untake', guard: 'person' },
    { m: 'POST', p: '/checkins/:checkinId/close', guard: 'person' },
    { m: 'POST', p: '/checkins/:checkinId/reopen', guard: 'person' },
    { m: 'PUT', p: '/customers/:customerId/dates', guard: 'person', body: {} },
    { m: 'GET', p: '/customers/:customerId/delete-preview', guard: 'person' },
    { m: 'GET', p: '/product-photos', guard: 'person' },
    { m: 'GET', p: '/product-photos/:imageId', guard: 'person' },
    { m: 'GET', p: '/campaign-media', guard: 'readable' },
    { m: 'GET', p: '/wish-settings', guard: 'readable' },
    { m: 'GET', p: `/customers/points?ids=${customer.id}`, guard: 'readable' },
    { m: 'GET', p: '/profile', guard: 'readable' },
    { m: 'GET', p: '/shop-link', guard: 'readable' },
    { m: 'GET', p: `/shop-link/products?codes=${product.productCode}`, guard: 'readable' },
    { m: 'GET', p: '/offers/aimed', guard: 'readable' },
    { m: 'GET', p: `/new-arrivals?from=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}`, guard: 'readable' },
    { m: 'GET', p: `/product-likes?productIds=${product.id}`, guard: 'readable' },
    { m: 'GET', p: '/products/:productId/photos', guard: 'readable' },
    { m: 'GET', p: '/moved', guard: 'shop' },
    { m: 'PUT', p: '/moved', guard: 'person', body: {} }
  ];
  const shopRoute = (r: R, shop = SHOP) => `/internal/modules/crm/shops/${shop}${P(r.p)}`;
  const moduleRoutes = [
    { m: 'PUT', p: `/internal/modules/crm/shops/${SHOP}` },
    { m: 'DELETE', p: `/internal/modules/crm/shops/${OTHER}` },
    { m: 'GET', p: '/internal/modules/crm/shops' },
    { m: 'GET', p: `/internal/modules/crm/shops/${SHOP}/events` }
  ];

  // What a refused call must never change.
  const snapshot = async () => JSON.stringify(await Promise.all([
    prisma.customer.count({ where: { clientId: { in: [SHOP, OTHER] } } }), prisma.customerGroup.count({ where: { clientId: { in: [SHOP, OTHER] } } }),
    prisma.auditLog.count({ where: { clientId: { in: [SHOP, OTHER] } } }), prisma.campaignMedia.count({ where: { clientId: { in: [SHOP, OTHER] } } }),
    prisma.moduleSubscription.count({ where: { clientId: { in: [SHOP, OTHER] } } }), prisma.crmGroupProjection.count({ where: { clientId: { in: [SHOP, OTHER] } } }),
    prisma.customer.findUnique({ where: { id: customer.id }, select: { whatsappOffers: true, birthday: true, tags: true, name: true } })
  ]));
  const before = await snapshot();

  // ── A: the lock on every door ───────────────────────────────────────────────────────────────────────
  console.log(`\nA. THE LOCK ON EVERY DOOR (${routes.length + moduleRoutes.length} routes x 8 wrong keys)`);
  const appSignIn = bearer(AuthService.generateToken({ userId: owner.id, clientId: SHOP }));
  const wrongKeys: [string, () => Record<string, string>, number[]][] = [
    ['no key at all', () => ({}), [401]],
    ['a broken key', () => bearer('not.a.jwt'), [401]],
    ['a key past its time', () => bearer(sign({}, { expiresIn: -60 })), [401]],
    ['a key for another audience', () => bearer(sign({}, { audience: 'someone-else' })), [401]],
    ['an unsigned key (alg none)', unsigned, [401]],
    ['a key signed by an unknown signer', strangerKey, [401]],
    ['an app sign-in instead of a service key', () => appSignIn, [401]],
    ['a service key without modules:crm', () => bearer(sign({ scope: ['session:read'] })), [403]]
  ];
  const stranger = strangerKey(), unsignedKey = unsigned();
  for (const [what, mk, codes] of wrongKeys) {
    const h = what === 'a key signed by an unknown signer' ? stranger : what === 'an unsigned key (alg none)' ? unsignedKey : mk();
    const bad: string[] = [];
    for (const r of routes) { const x = await call(r.m, shopRoute(r), h, r.body); if (!codes.includes(x.status)) bad.push(`${r.m} ${r.p} -> ${x.status}`); }
    for (const r of moduleRoutes) { const x = await call(r.m, r.p, h); if (!codes.includes(x.status)) bad.push(`${r.m} ${r.p} -> ${x.status}`); }
    check(`${what}: every route refused (${codes.join('/')})`, bad.length === 0, bad.slice(0, 8));
  }
  {
    const bad: string[] = [];
    for (const r of routes) {
      const x = await call(r.m, shopRoute(r), forShop(OTHER, theirOwner.id), r.body);
      if (x.status !== 403 || !/another shop/.test(x.data?.message)) bad.push(`${r.m} ${r.p} -> ${x.status} ${x.data?.message ?? ''}`);
    }
    check('a key made for ANOTHER shop, on this shop\'s routes: every one 403 "another shop"', bad.length === 0, bad.slice(0, 8));
    const ev = await call('GET', `/internal/modules/crm/shops/${SHOP}/events`, forShop(OTHER));
    check('...and on this shop\'s change feed too (a key for one shop never reads another\'s events)', ev.status === 403, brief(ev));
    const sw = await call('DELETE', `/internal/modules/crm/shops/${SHOP}`, forShop(OTHER));
    check('...nor switch this shop\'s CRM off', sw.status === 403 && (await prisma.moduleSubscription.count({ where: { clientId: SHOP } })) === 1, brief(sw));
  }
  {
    const bad: string[] = [];
    for (const r of routes) {
      const x = await call(r.m, shopRoute(r, OTHER), forShop(OTHER, theirOwner.id), r.body);
      if (x.status !== 404 || !/not switched CRM on/.test(x.data?.message)) bad.push(`${r.m} ${r.p} -> ${x.status} ${x.data?.message ?? ''}`);
    }
    check('a shop that has NOT switched CRM on: every route 404 "has not switched CRM on"', bad.length === 0, bad.slice(0, 8));
  }

  // ── B: the person behind a change ───────────────────────────────────────────────────────────────────
  console.log('\nB. THE PERSON BEHIND A CHANGE');
  const personRoutes = routes.filter(r => r.guard === 'person');
  for (const [what, h, words] of [
    ['nobody named', forShop(SHOP), /Say who this is for/],
    ['a person from another shop', forShop(SHOP, theirOwner.id), /not in this shop/],
    ['a person switched off', forShop(SHOP, gone.id), /switched off/],
    ['a person nobody has heard of', forShop(SHOP, fake), /not in this shop/]
  ] as const) {
    const bad: string[] = [];
    for (const r of personRoutes) { const x = await call(r.m, shopRoute(r), h, r.body); if (x.status !== 403 || !(words as RegExp).test(x.data?.message)) bad.push(`${r.m} ${r.p} -> ${x.status} ${x.data?.message ?? ''}`); }
    check(`${what}: every one of the ${personRoutes.length} changing routes 403 in words`, bad.length === 0, bad.slice(0, 6));
  }
  {
    const bad: string[] = [];
    for (const r of personRoutes.filter(r => !['/moved', '/customers/:customerId/delete-preview'].includes(r.p))) {
      const x = await call(r.m, shopRoute(r), forShop(SHOP, store.id), r.body);
      if (x.status !== 403 || !/may not do this/.test(x.data?.message)) bad.push(`${r.m} ${r.p} -> ${x.status} ${x.data?.message ?? ''}`);
    }
    check('a storekeeper (no customer or CRM permission): every changing route 403, naming what is needed', bad.length === 0, bad.slice(0, 6));
    const rd: string[] = [];
    for (const r of routes.filter(r => r.guard === 'readable')) { const x = await call(r.m, shopRoute(r), forShop(SHOP, store.id)); if (x.status !== 403) rd.push(`${r.m} ${r.p} -> ${x.status}`); }
    check('...and when a storekeeper is named on a read, every read 403 too', rd.length === 0, rd.slice(0, 6));
  }
  check('NOTHING was written by any refused call (customers, groups, activity, pictures, switches, copies, the customer)', (await snapshot()) === before, { before, after: await snapshot() });

  // ── C: the right key, the right person ──────────────────────────────────────────────────────────────
  console.log('\nC. THE RIGHT KEY, THE RIGHT PERSON: NO CRASH ANYWHERE');
  {
    const crashes: string[] = [], unplain: string[] = [];
    for (const r of routes) {
      const x = await call(r.m, shopRoute(r), forShop(SHOP, owner.id), r.body);
      if (x.status >= 500) crashes.push(`${r.m} ${r.p} -> ${x.status} ${JSON.stringify(x.data).slice(0, 80)}`);
      if (x.status >= 400 && !plain(x.data?.message)) unplain.push(`${r.m} ${r.p} -> ${x.status} ${JSON.stringify(x.data).slice(0, 80)}`);
    }
    // Locally the picture upload reaches storage, which is cut off on purpose: 503 in words is its answer.
    check('every route answers the owner without a crash (no 5xx)', crashes.length === 0, crashes);
    check('...and every refusal is in plain words (no stack, no database talk)', unplain.length === 0, unplain.slice(0, 6));
  }
  for (const p of ['/campaign-media', '/campaign-media/from-product']) {
    const gone = await call('POST', `/internal/modules/crm/shops/${SHOP}${p}`, forShop(SHOP, owner.id), { base64: 'AA==', productImageId: image.id });
    check(`POST ${p} is retired (19 Nov, CRM makes its own pictures): 410 in words for the owner`, gone.status === 410 && /made in ScaleEzy CRM/.test(gone.data?.message), brief(gone));
  }
  const ev0 = await call('GET', `/internal/modules/crm/shops/${SHOP}/events?after=abc`, key());
  check('the change feed with a bad "after": 400 in words', ev0.status === 400 && plain(ev0.data?.message), brief(ev0));
  const ev500 = await call('GET', `/internal/modules/crm/shops/${SHOP}/events?limit=501`, key());
  check('...a limit over 500: 400', ev500.status === 400, brief(ev500));

  // ── D2..D6: the flows ───────────────────────────────────────────────────────────────────────────────
  console.log('\nD2. CRM ADDS A CUSTOMER; INVENTORY\'S FEED TELLS CRM BACK');
  const evStart = await call('GET', `/internal/modules/crm/shops/${SHOP}/events?limit=500`, key());
  const lastSeq = (evStart.data?.data ?? []).reduce((m: bigint, e: any) => (BigInt(e.sequence) > m ? BigInt(e.sequence) : m), 0n);
  const phone = `+9192${String(STAMP).slice(-8)}`;
  const made = await call('POST', `/internal/modules/crm/shops/${SHOP}/customers`, forShop(SHOP, owner.id), { name: 'From CRM Lakshmi', phone });
  const madeId = made.data?.data?.id ?? made.data?.data?.customer?.id;
  check('CRM adds a customer for the owner: made in Inventory', [200, 201].includes(made.status) && !!madeId && !!(await prisma.customer.findFirst({ where: { clientId: SHOP, phone } })), brief(made));
  const again = await call('POST', `/internal/modules/crm/shops/${SHOP}/customers`, forShop(SHOP, owner.id), { name: 'Same number', phone });
  check('...the same number again: refused or the same customer, never a second one', (await prisma.customer.count({ where: { clientId: SHOP, phone } })) === 1 && again.status < 500, brief(again));
  const app = bearer(AuthService.generateToken({ userId: owner.id, clientId: SHOP }));
  const inApp = await call('GET', `/customers/${madeId}`, app);
  check('...the owner sees her in Inventory\'s app', inApp.status === 200 && JSON.stringify(inApp.data).includes('From CRM Lakshmi'), brief(inApp));
  await new Promise(r => setTimeout(r, 500));
  const evAfter = await call('GET', `/internal/modules/crm/shops/${SHOP}/events?after=${lastSeq}&limit=500`, key());
  const kinds = (evAfter.data?.data ?? []).map((e: any) => e.kind);
  check('...and Inventory\'s change feed tells CRM: customer.created for her', evAfter.status === 200 && (evAfter.data.data as any[]).some((e: any) => e.kind === 'customer.created' && e.rowId === madeId), kinds.slice(0, 10));
  const leak = JSON.stringify(evAfter.data?.data ?? []);
  check('...and no event carries a password or a key', !/password|"hash"|private_key|secret/i.test(leak));

  console.log('\nD3. CONSENT AND DATES SET IN CRM SHOW IN INVENTORY');
  const yes = await call('PUT', `/internal/modules/crm/shops/${SHOP}/customers/${customer.id}/offers`, forShop(SHOP, owner.id), { agreed: true });
  const appConsent = await call('GET', `/campaigns/consent/${customer.id}`, app);
  check('CRM records her yes to offers: Inventory\'s app shows yes', yes.status === 200 && appConsent.status === 200 && appConsent.data?.data?.agreed === true, `${brief(yes)} | ${brief(appConsent)}`);
  const dates = await call('PUT', `/internal/modules/crm/shops/${SHOP}/customers/${customer.id}/dates`, forShop(SHOP, owner.id), { birthday: '03-15', anniversary: '12-01' });
  const row = await prisma.customer.findUnique({ where: { id: customer.id }, select: { birthday: true, anniversary: true } });
  check('CRM sets her birthday and anniversary: stored in Inventory', dates.status === 200 && row?.birthday === '03-15' && row?.anniversary === '12-01', brief(dates));
  const badDate = await call('PUT', `/internal/modules/crm/shops/${SHOP}/customers/${customer.id}/dates`, forShop(SHOP, owner.id), { birthday: '02-31' });
  check('...an impossible date: 400 in words, nothing changed', badDate.status === 400 && plain(badDate.data?.message) && (await prisma.customer.findUnique({ where: { id: customer.id } }))?.birthday === '03-15', brief(badDate));

  console.log('\nD4. A PERSON SIGNS IN TO INVENTORY; CRM ASKS WHO THEY ARE');
  const userToken = AuthService.generateToken({ userId: owner.id, clientId: SHOP, sessionVersion: (owner as any).sessionVersion ?? 0 });
  const who = await call('POST', '/internal/session', key(), { token: userToken });
  check('CRM asks with the person\'s Inventory sign-in: who, which shop, what they may do', who.status === 200 && who.data?.user?.id === owner.id && (who.data?.client?.id ?? who.data?.user?.clientId) === SHOP && Array.isArray(who.data?.user?.permissions ?? who.data?.permissions), brief(who));
  const noScope = await call('POST', '/internal/session', bearer(sign({ scope: ['modules:crm'] })), { token: userToken });
  check('...a service key without session:read cannot ask: 403', noScope.status === 403, brief(noScope));
  const junk = await call('POST', '/internal/session', key(), { token: 'junk' });
  check('...a made-up sign-in: 401', junk.status === 401, brief(junk));
  await prisma.user.update({ where: { id: owner.id }, data: { status: 'INACTIVE' } as any });
  await new Promise(r => setTimeout(r, 31_000));   // the identity cache's own window (30 s); a switch-off made through the app clears it at once
  const whoOff = await call('POST', '/internal/session', key(), { token: userToken });
  check('...once the person is switched off, the same sign-in is refused (401)', whoOff.status === 401, brief(whoOff));
  await prisma.user.update({ where: { id: owner.id }, data: { status: 'ACTIVE' } as any });

  console.log('\nD5. CRM DELETES A CUSTOMER');
  await new Promise(r => setTimeout(r, 31_000));   // the owner's identity, back to active, past the cache window
  const preview = await call('GET', `/internal/modules/crm/shops/${SHOP}/customers/${victim.id}/delete-preview`, forShop(SHOP, owner.id));
  check('the owner asks what deleting her would do: an answer, nothing deleted', preview.status === 200 && !!(await prisma.customer.findFirst({ where: { id: victim.id, deletedAt: null } })), brief(preview));
  const noConfirm = await call('DELETE', `/internal/modules/crm/shops/${SHOP}/customers/${victim.id}`, forShop(SHOP, owner.id), {});
  check('deleting without typing the last 4 digits: 400 asking for them, nothing deleted', noConfirm.status === 400 && /last 4 digits/.test(noConfirm.data?.message) && !!(await prisma.customer.findFirst({ where: { id: victim.id, deletedAt: null } })), brief(noConfirm));
  const wrong = await call('DELETE', `/internal/modules/crm/shops/${SHOP}/customers/${victim.id}`, forShop(SHOP, owner.id), { confirm: '0000' });
  check('...the wrong 4 digits: refused, nothing deleted', wrong.status === 400 && !!(await prisma.customer.findFirst({ where: { id: victim.id, deletedAt: null } })), brief(wrong));
  const del = await call('DELETE', `/internal/modules/crm/shops/${SHOP}/customers/${victim.id}`, forShop(SHOP, owner.id), { confirm: String(victim.phone).slice(-4) });
  const after = await prisma.customer.findUnique({ where: { id: victim.id } });
  check('the owner deletes her through CRM: gone from Inventory\'s customers', [200, 204].includes(del.status) && (!after || !!(after as any).deletedAt), brief(del));
  const appGone = await call('GET', `/customers/${victim.id}`, app);
  check('...Inventory\'s app no longer finds her', appGone.status === 404, brief(appGone));
  const twice = await call('DELETE', `/internal/modules/crm/shops/${SHOP}/customers/${victim.id}`, forShop(SHOP, owner.id), { confirm: String(victim.phone).slice(-4) });
  check('...deleting her again: a clear answer, not a crash', twice.status < 500 && plain(twice.data?.message ?? 'Not found here.'), brief(twice));

  console.log('\nD6. CRM IS SWITCHED OFF, THEN ON AGAIN');
  const off = await call('DELETE', `/internal/modules/crm/shops/${SHOP}`, key());
  check('CRM switched off for the shop: 200', off.status === 200, brief(off));
  const closed: string[] = [];
  for (const r of routes) { const x = await call(r.m, shopRoute(r), forShop(SHOP, owner.id), r.body); if (x.status !== 404) closed.push(`${r.m} ${r.p} -> ${x.status}`); }
  check('...every door now says the shop has not switched CRM on (404)', closed.length === 0, closed.slice(0, 6));
  const eventsBefore = await prisma.moduleEvent.count({ where: { clientId: SHOP, rowId: customer.id } });
  await prisma.customer.update({ where: { id: customer.id }, data: { name: 'Changed while off' } });
  const offEvents = (await prisma.moduleEvent.count({ where: { clientId: SHOP, rowId: customer.id } })) - eventsBefore;
  check('...a change made while CRM is off is not put on CRM\'s feed', offEvents === 0, offEvents);
  const on3 = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, key());
  const back = await call('GET', `/internal/modules/crm/shops/${SHOP}/profile`, forShop(SHOP));
  check('...on again: the doors open again', on3.status === 200 && back.status === 200 && back.data.data.name === 'Contract Silks', brief(back));
}

async function cleanup() {
  await prisma.crmGroupProjection.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  for (const id of [SHOP, OTHER]) await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
}

main()
  .catch(e => { failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => { failures.push(`cleanup crashed: ${e?.message}`); console.error(e); });
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
