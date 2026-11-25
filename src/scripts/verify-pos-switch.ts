/**
 * The POS switch (25 Nov 2026; POS's spec D:/villy/pos/PLAN-boutique-pos-switch.md), against the REAL local Inventory
 * server and database. A stand-in for POS's door listens on POS_API_URL (localhost:4007, while POS's own server is not
 * running): it checks Inventory's call the way POS does -- the RS256 pass with Inventory's dev public key, kid, issuer,
 * audience, at most 5 minutes, the shop, scope pos:setup -- and that the till key it is handed really opens that shop
 * here (GET /pos/v1/catalogue). POS's own door test (42 checks) is then run by the POS session against this real call.
 *
 *   Console: status, on (till key "POS" made, owner from the shop's login), on again (old key retired), POS refusing
 *   (the new key taken back), POS away (nothing changed), off, owner link with reset.
 *   Settings → POS: replacing the key hands the new one to POS.
 *   Boutique API: PUT /settings/pos for a boutique-only shop (owner named), who may, bad input.
 *
 * Throwaway shops only (posswitch-*). Local only; POS's port must be free.
 *   (the 4036 runner's env) npx tsx src/scripts/verify-pos-switch.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import { execSync } from 'node:child_process';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const PUBLIC = fs.readFileSync('dev-keys/inventory-public.pem', 'utf8');
const KID = 'inv-local-dev';
const POS_PORT = 4007;
const CONSOLE = execSync('npx tsx src/scripts/print-local-console-token.ts', { env: process.env, encoding: 'utf8' }).match(/eyJ[A-Za-z0-9._-]+/)![0];
const btqKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};

// ── the stand-in for POS's door ────────────────────────────────────────────────────────────────────
type Call = { path: string; body: any; claims: any; header: any; keyWorks?: boolean; problem?: string };
const calls: Call[] = [];
let refuseNext: string | null = null;
const onShops = new Set<string>();
const pos = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const call: Call = { path: String(req.url), body: raw ? JSON.parse(raw) : null, claims: null, header: jwt.decode(token, { complete: true })?.header };
    calls.push(call);
    try {
      call.claims = jwt.verify(token, PUBLIC, { algorithms: ['RS256'], issuer: 'scaleezy-inventory', audience: 'scaleezy-pos' });
    } catch (e: any) { call.problem = `pass refused: ${e.message}`; return send(401, { message: 'Not Inventory.' }); }
    const c = call.claims;
    if (call.header?.kid !== KID || !Array.isArray(c.scope) || !c.scope.includes('pos:setup') || !c.clientId || c.exp - c.iat > 300) {
      call.problem = 'claims'; return send(401, { message: 'Bad pass.' });
    }
    const path = String(req.url).replace(/^\/api\/v1\/from-inventory\/pos/, '');
    if (path === '/status') return send(200, { posOn: onShops.has(c.clientId), shop: c.clientId });
    if (path === '/disable') { onShops.delete(c.clientId); return send(200, { posOn: false }); }
    if (path === '/owner-link') return send(200, { ownerLink: `http://pos.local/welcome/${S}${call.body?.reset ? '?reset' : ''}` });
    if (path === '/enable') {
      if (refuseNext) { const m = refuseNext; refuseNext = null; return send(409, { message: m }); }
      // Like POS: the key must really open THIS shop's catalogue at Inventory.
      const r = await axios.get(`${BASE}/pos/v1/catalogue?limit=1`, { headers: { 'x-storefront-key': call.body?.tillKey ?? '' }, validateStatus: () => true });
      call.keyWorks = r.status === 200;
      if (!call.keyWorks) return send(409, { message: 'That till key does not open the shop.' });
      if (!onShops.has(c.clientId) && !call.body?.owner?.name) return send(409, { message: 'Say who the owner is: a new POS shop needs its owner.' });
      onShops.add(c.clientId);
      return send(200, { posOn: true, shop: c.clientId, posAddress: 'http://pos.local', owner: call.body?.owner ?? null, ownerLink: `http://pos.local/welcome/${S}`, made: true });
    }
    send(404, { message: 'No such door.' });
  });
});

async function consoleApi(method: string, path: string, body?: unknown) {
  const r = await axios.request({ method, url: `${BASE}/admin${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Cookie: `platform_admin_token=${CONSOLE}`, Origin: 'http://localhost:5183' } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const btqPass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  btqKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function btq(method: string, p: string, tenant: string, body?: unknown, can = ['settings:write']) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Authorization: `Bearer ${btqPass(tenant, can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `ps-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const tills = (clientId: string) => prisma.storefrontConnection.findMany({ where: { clientId, baseUrl: 'pos://counter' }, select: { id: true, name: true, status: true, credentialPrefix: true, locationIds: true }, orderBy: { createdAt: 'asc' } });
const lastEnable = () => [...calls].reverse().find(c => c.path.endsWith('/enable'));

let clientId = '';
const TEN = `posswitch-${S}`;
async function main() {
  await new Promise<void>((resolve, reject) => { pos.once('error', reject); pos.listen(POS_PORT, '127.0.0.1', () => resolve()); });

  console.log('A RETAIL CLIENT, MADE BY THE CONSOLE\'S OWN ONBOARDING');
  const made = await consoleApi('POST', '/clients', { companyName: `POS Switch ${S}`, adminName: 'Kavya Rao', adminEmail: `posswitch-${S}@example.invalid`, ownerPhone: '9848012345', city: 'Guntur', sells: 'READY_MADE' });
  clientId = made.data?.clientId;
  check('a client with an owner login and a Main Store', made.status < 300 && !!clientId, made);

  console.log('\nTHE CONSOLE SWITCH');
  const st0 = await consoleApi('GET', `/clients/${clientId}/pos`);
  check('status: set up here, POS off', st0.status === 200 && st0.data?.configured === true && st0.data?.posOn === false, st0);
  const on = await consoleApi('POST', `/clients/${clientId}/pos/on`, {});
  const e1 = lastEnable();
  check('switched on: 200 with POS\'s address and the owner\'s welcome link', on.status === 200 && on.data?.posOn === true && !!on.data?.posAddress && !!on.data?.ownerLink, on);
  check('...the call was signed as POS expects: RS256, kid inv-local-dev, iss/aud, 5 min, this shop, pos:setup, who pressed it', !!e1 && !e1.problem && e1.header?.alg === 'RS256' && e1.claims?.clientId === clientId && e1.claims?.exp - e1.claims?.iat === 300 && /ScaleEzy Console/.test(e1.claims?.onBehalfOf?.name ?? ''), e1 && { problem: e1.problem, header: e1.header, claims: e1.claims });
  check('...the body: the shop\'s name, a till key, and the owner from the shop\'s login', e1?.body?.shopName === `POS Switch ${S}` && typeof e1?.body?.tillKey === 'string' && e1?.body?.owner?.name === 'Kavya Rao' && e1?.body?.owner?.email === `posswitch-${S}@example.invalid`, e1?.body);
  check('...and that till key really opens this shop here (POS\'s own check)', e1?.keyWorks === true);
  let t = await tills(clientId);
  const main = await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
  check('Inventory now has one till key "POS", selling from the Main Store', t.length === 1 && t[0].name === 'POS' && t[0].status === 'ACTIVE' && t[0].locationIds[0] === main?.id, t);

  const again = await consoleApi('POST', `/clients/${clientId}/pos/on`, {});
  t = await tills(clientId);
  check('switched on again: a fresh key handed over, the earlier one retired -- still ONE working key', again.status === 200 && t.filter(x => x.status === 'ACTIVE').length === 1 && t.length === 2 && t[0].status === 'REVOKED', t);

  refuseNext = 'This POS shop belongs to another Inventory shop.';
  const refused = await consoleApi('POST', `/clients/${clientId}/pos/on`, {});
  t = await tills(clientId);
  check('POS refuses: 409 in POS\'s own words; the key made for it is taken back, the working one stays', refused.status === 409 && /another Inventory shop/.test(refused.message ?? '') && t.filter(x => x.status === 'ACTIVE').length === 1 && t[t.length - 1].status === 'REVOKED', { refused, t });

  console.log('\nTHE SHOP\'S SETTINGS → POS: NOTHING BY HAND (25 Nov: all automatic)');
  const owner = await prisma.user.findFirst({ where: { clientId } });
  const token = AuthService.generateToken({ userId: owner!.id, clientId, sessionVersion: (owner as any).sessionVersion });
  const working = t.find(x => x.status === 'ACTIVE')!;
  const asOwner = (method: 'get' | 'post', p: string, body?: unknown) => axios.request({ method, url: `${BASE}/pos-connections${p}`, data: body, headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost:5183' }, validateStatus: () => true });
  const st = await asOwner('get', '/state');
  check('the shop sees its POS: on, switched on by ScaleEzy, with where to bill', st.status === 200 && st.data?.data?.show === true && st.data?.data?.managed === true && !!st.data?.data?.posAddress, st.data);
  const mk = await asOwner('post', '', { locationId: working.locationIds[0] });
  const rep = await asOwner('post', `/${working.id}/replace-key`);
  const dis = await asOwner('post', `/${working.id}/disconnect`);
  check('the owner cannot make, replace or disconnect a till key: 409, "made and changed automatically", nothing changed', [mk, rep, dis].every(r => r.status === 409 && /automatically/.test(r.data?.message ?? ''))
    && (await tills(clientId)).filter(x => x.status === 'ACTIVE').length === t.filter(x => x.status === 'ACTIVE').length, [mk.status, rep.status, dis.status]);

  console.log('\nOFF, OWNER LINK');
  const link = await consoleApi('POST', `/clients/${clientId}/pos/owner-link`, { reset: true });
  check('new owner link with reset: POS was asked to reset', link.status === 200 && /reset/.test(link.data?.ownerLink ?? '') && calls[calls.length - 1].body?.reset === true, link);
  const off = await consoleApi('POST', `/clients/${clientId}/pos/off`);
  check('switched off: POS was told; the till key is kept (switching on later needs no paste)', off.status === 200 && off.data?.posOn === false && (await tills(clientId)).some(x => x.status === 'ACTIVE'), off);
  const stOff = await asOwner('get', '/state');
  check('...and the shop\'s POS section is hidden while POS is off', stOff.status === 200 && stOff.data?.data?.show === false && stOff.data?.data?.managed === false, stOff.data);
  check('a client that is not ours: 404', (await consoleApi('POST', `/clients/nope-${S}/pos/on`, {})).status === 404);

  console.log('\nPOS AWAY');
  await new Promise<void>(r => pos.close(() => r()));
  const tBefore = (await tills(clientId)).filter(x => x.status === 'ACTIVE').length;
  const away = await consoleApi('POST', `/clients/${clientId}/pos/on`, {});
  check('POS cannot be reached: 503 in words, and nothing changed here', away.status === 503 && /could not be reached/.test(away.message ?? '') && (await tills(clientId)).filter(x => x.status === 'ACTIVE').length === tBefore, away);
  await new Promise<void>((resolve) => pos.listen(POS_PORT, '127.0.0.1', () => resolve()));

  console.log('\nWHICH STORE THE TILL SELLS FROM (Jyoti Atelier, live 25 Nov: an empty Main Store beside the stocked one)');
  const mainStore = (await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } }))!;
  const stocked = await prisma.stockLocation.create({ data: { clientId, code: `BTQ-${S}`, name: 'Boutique - 1', type: 'STORE' as any, active: true } });
  const prod = await prisma.product.create({ data: { clientId, productCode: `PS-${S}`, slug: `ps-${S}`, title: 'Saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true } as any });
  const vr = await prisma.productVariant.create({ data: { clientId, productId: prod.id, variantCode: `PSV-${S}`, sku: `PSS-${S}`, sellingPrice: 1000 } as any });
  await prisma.inventoryStock.create({ data: { clientId, variantId: vr.id, locationId: stocked.id, quantity: 7 } as any });
  const j1 = await consoleApi('POST', `/clients/${clientId}/pos/on`, {});
  const tj1 = (await tills(clientId)).find(x => x.status === 'ACTIVE');
  check('the Main Store is empty, "Boutique - 1" holds the stock: the till sells from "Boutique - 1"', j1.status === 200 && tj1?.locationIds[0] === stocked.id, { j1: j1.status, at: tj1?.locationIds });
  await prisma.inventoryStock.create({ data: { clientId, variantId: vr.id, locationId: mainStore.id, quantity: 2 } as any });
  const j2 = await consoleApi('POST', `/clients/${clientId}/pos/on`, {});
  const tj2 = (await tills(clientId)).find(x => x.status === 'ACTIVE');
  check('...once the Main Store holds stock too, the till sells from the Main Store (it wins when it holds any)', j2.status === 200 && tj2?.locationIds[0] === mainStore.id, { j2: j2.status, at: tj2?.locationIds });

  console.log('\nTHE BOUTIQUE API SWITCH (a boutique-only shop, no logins)');
  const link2 = await btq('POST', '/link', TEN, { shopName: 'Switch Boutique' }, []);
  const btqClient = link2.data?.clientId;
  check('without settings:write: 403', (await btq('PUT', '/settings/pos', TEN, { on: true }, ['products:write'])).status === 403);
  check('"on" that is not true/false: 400 in words', (await btq('PUT', '/settings/pos', TEN, { on: 'yes' })).status === 400);
  const noOwner = await btq('PUT', '/settings/pos', TEN, { on: true });
  check('on, with no owner (no login to take it from): POS says to name the owner, nothing kept', noOwner.status === 409 && /owner/i.test(noOwner.message ?? '') && (await tills(btqClient)).every(x => x.status === 'REVOKED'), noOwner);
  const bOn = await btq('PUT', '/settings/pos', TEN, { on: true, owner: { name: 'Swathi', phone: '9848011111' } });
  const eb = lastEnable();
  check('on, naming the owner: POS on for the boutique\'s shop, signed for THAT shop, by "<person> (Boutique)"', bOn.status === 200 && bOn.data?.posOn === true && eb?.claims?.clientId === btqClient && eb?.claims?.onBehalfOf?.name === 'Lakshmi (Boutique)' && eb?.body?.owner?.name === 'Swathi', { bOn, claims: eb?.claims });
  const bSt = await btq('GET', '/settings/pos', TEN, undefined, []);
  check('anyone of the boutique may read the state', bSt.status === 200 && bSt.data?.posOn === true, bSt);
  const bOff = await btq('PUT', '/settings/pos', TEN, { on: false });
  check('off', bOff.status === 200 && bOff.data?.posOn === false, bOff);
  check('no call ever reached POS without a valid pass', calls.every(c => !c.problem), calls.filter(c => c.problem).map(c => c.problem));
}

async function cleanup() {
  await new Promise<void>(r => pos.close(() => r()));
  const ids = [clientId, ...(await prisma.boutiqueLink.findMany({ where: { tenant: TEN }, select: { clientId: true } })).map(l => l.clientId)].filter(Boolean);
  if (!ids.length) return;
  await prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} shops`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
