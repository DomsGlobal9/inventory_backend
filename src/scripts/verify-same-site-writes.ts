/**
 * A change made with the login cookie must come from our own app (security review, 28 Oct).
 *
 * The forged request that closed a shop -- the owner's cookie, a foreign Origin, a body a plain HTML
 * form can send -- is refused, and every real caller still works: the app itself, a localhost dev
 * copy, Bearer callers (POS, scripts, Android), reads, tools that send no Origin, webhooks.
 * Runs against a throwaway shop with its own online shop.
 *
 *   VERIFY_API_URL=http://localhost:4016/api/v1 npx tsx src/scripts/verify-same-site-writes.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { env } from '../config/env';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `samesite-${STAMP}`;
const APP = new URL(env.FRONTEND_URL).origin;

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 200)}`;
const call = (method: string, path: string, headers: Record<string, string>, data?: any) =>
  axios.request({ method, url: `${BASE}${path}`, headers, data, validateStatus: () => true, timeout: 60_000, transformRequest: [(d) => d] });

async function main() {
  console.log(`SETUP ${SHOP} (app origin ${APP}, NODE_ENV ${env.NODE_ENV})`);
  const roles = await seedRolesForClient(SHOP);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Same Site Sarees' } });
  const user = await prisma.user.create({ data: { clientId: SHOP, email: `ss-${SHOP}@example.com`, name: 'Owner', password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roles.SUPER_ADMIN } });
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const token = AuthService.generateToken({ userId: user.id, clientId: SHOP });
  const cookie = { Cookie: `token=${token}` };
  const bearer = { Authorization: `Bearer ${token}` };
  const asForm = { 'Content-Type': 'text/plain' };

  const slug = await call('POST', '/online-shop/address', { ...bearer, 'Content-Type': 'application/json' }, JSON.stringify({ slug: `ss${String(STAMP).slice(-8)}` }));
  const stores = await call('PATCH', '/online-shop', { ...bearer, 'Content-Type': 'application/json' }, JSON.stringify({ locationIds: [store.id] }));
  const opened = await call('POST', '/online-shop/open', bearer);
  const isLive = async () => (await call('GET', '/online-shop', bearer)).data?.data?.isLive;
  check('setup: the throwaway shop has an online shop and it is live', slug.status === 200 && stores.status === 200 && opened.status === 200 && await isLive() === true, `${brief(slug)} | ${brief(stores)} | ${brief(opened)}`);

  console.log('\n1. FORGED FROM ANOTHER WEBSITE: REFUSED');
  const forged = await call('POST', '/online-shop/close', { ...cookie, ...asForm, Origin: 'https://evil.example' }, '');
  check('the hidden-form request (cookie, Origin evil.example, text/plain, no body) is refused with 403', forged.status === 403 && /did not come from the ScaleEzy app/.test(forged.data?.message ?? ''), brief(forged));
  check('...and the shop is still live', await isLive() === true);
  const nullOrigin = await call('POST', '/online-shop/close', { ...cookie, ...asForm, Origin: 'null' }, '');
  check('Origin "null" (sandboxed frame, data: page) is refused', nullOrigin.status === 403, brief(nullOrigin));
  const noOriginCross = await call('POST', '/online-shop/close', { ...cookie, ...asForm, 'Sec-Fetch-Site': 'cross-site' }, '');
  check('no Origin but the browser says cross-site: refused', noOriginCross.status === 403, brief(noOriginCross));
  const lookalike = await call('POST', '/online-shop/close', { ...cookie, ...asForm, Origin: `${APP}.evil.example` }, '');
  check('a look-alike origin (app origin + ".evil.example") is refused', lookalike.status === 403, brief(lookalike));
  const otherWrite = await call('POST', '/auth/me/sign-out-other-devices', { ...cookie, ...asForm, Origin: 'https://evil.example' }, '');
  check('"sign out other devices" from another site: refused too', otherWrite.status === 403, brief(otherWrite));
  const del = await call('DELETE', '/shelves/spots/00000000-0000-0000-0000-000000000000', { ...cookie, Origin: 'https://evil.example' });
  check('a DELETE with the cookie from another site: refused', del.status === 403, brief(del));
  check('after all of that, the shop is still live', await isLive() === true);

  console.log('\n2. REAL CALLERS: STILL WORK');
  const fromApp = await call('POST', '/online-shop/close', { ...cookie, ...asForm, Origin: APP, 'Sec-Fetch-Site': 'same-site' }, '');
  check(`the app itself (Origin ${APP}) can close the shop`, fromApp.status === 200 && await isLive() === false, brief(fromApp));
  const reopen = await call('POST', '/online-shop/open', { ...cookie, Origin: APP });
  check('...and open it again', reopen.status === 200 && await isLive() === true, brief(reopen));
  if (env.NODE_ENV === 'development') {
    const dev = await call('POST', '/online-shop/close', { ...cookie, Origin: 'http://localhost:5183' });
    check('a localhost dev copy (development only) works', dev.status === 200, brief(dev));
    await call('POST', '/online-shop/open', bearer);
  }
  const viaBearer = await call('POST', '/online-shop/close', { ...bearer, Origin: 'https://evil.example' });
  check('a Bearer caller (POS, scripts, Android) is not affected: a forged page cannot set that header', viaBearer.status === 200, brief(viaBearer));
  await call('POST', '/online-shop/open', bearer);
  const read = await call('GET', '/online-shop', { ...cookie, Origin: 'https://evil.example' });
  check('reads are not affected (CORS still keeps the answer from the other site)', read.status === 200, brief(read));
  const tool = await call('POST', '/online-shop/close', { ...cookie });
  check('a tool that sends no Origin and no Sec-Fetch-Site (curl, server code) works', tool.status === 200, brief(tool));
  await call('POST', '/online-shop/open', bearer);
  const json = await call('POST', '/online-shop/address', { ...cookie, 'Content-Type': 'application/json', Origin: APP }, JSON.stringify({ slug: `ss${String(STAMP).slice(-8)}` }));
  check('a JSON write from the app works', json.status === 200, brief(json));

  console.log('\n3. OTHER DOORS UNCHANGED');
  const anon = await call('POST', '/online-shop/close', { Origin: 'https://evil.example' });
  check('no login at all: still the usual 401, not this check', anon.status === 401, brief(anon));
  const hook = await call('POST', '/shopify/webhooks', { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': 'bad', Origin: 'https://evil.example' }, '{}');
  check('Shopify webhook with a bad signature: still its own 401 (or 503 if Shopify is not set up here)', hook.status === 401 || hook.status === 503, brief(hook));
  const login = await call('POST', '/auth/login', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, JSON.stringify({ email: 'nobody@example.com', password: 'x' }));
  check('the login form itself is not blocked by this check (no cookie yet)', login.status !== 403, brief(login));
}

async function cleanup() {
  await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', e?.message); });
  const left = await prisma.user.count({ where: { clientId: SHOP } });
  check('the throwaway shop is gone', left === 0, String(left));
}

main()
  .catch(e => { failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => { failures.push(`cleanup crashed: ${e?.message}`); console.error(e); });
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
