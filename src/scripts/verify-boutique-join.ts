/**
 * A boutique-only client asks to join ScaleEzy Inventory (16 Nov), end to end against the REAL local server and database:
 * the boutique app's three calls (ask, status, withdraw) with its signed pass, and the Platform Console's list, accept
 * and decline -- and every case around them: bad details, asking twice, five asks at once, an account already on a
 * client, an owner email already in use, two admins accepting at once, decline then ask again, withdrawing while being
 * set up, and above all that the boutique's items, stock and history really land in the new shop and its next call
 * works there.
 *
 * Throwaway boutique accounts only (jointest-*); every client, link and request it makes is removed. Mail is off on
 * the local server, so onboarding sends nothing. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-join.ts
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');
const CONSOLE = execSync('npx tsx src/scripts/print-local-console-token.ts', { env: process.env, encoding: 'utf8' }).match(/eyJ[A-Za-z0-9._-]+/)![0];

const S = Date.now().toString(36);
const T = (n: string) => `jointest-${n}-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
};

const pass = (tenant: string | null, o: { name?: string } = {}) => jwt.sign({
  sub: 'crm-b', scope: ['modules:boutique'], ...(tenant ? { tenant } : {}),
  onBehalfOf: { userId: 'sa-1', name: o.name ?? 'CRM-B super admin', can: ['products:write', 'stock:write', 'stitching:issue'] }
}, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function boutique(method: string, path: string, tenant: string | null, body?: unknown) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(tenant)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `join-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
async function consoleApi(method: string, path: string, body?: unknown, signedIn = true) {
  const r = await axios.request({ method, url: `${BASE}/admin${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { ...(signedIn ? { Cookie: `platform_admin_token=${CONSOLE}` } : {}), Origin: 'http://localhost:5183' } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const owner = (k: string) => ({ shopName: `Jyothi Boutique ${k}`, ownerName: 'Jyothi', ownerEmail: `jyothi-${k}-${S}@example.invalid`, ownerPhone: '9848012345', city: 'Guntur' });
const cardFor = async (tenant: string) => ((await consoleApi('GET', '/boutique-join-requests')).data ?? []).find((r: any) => r.tenant === tenant);

async function main() {
  console.log('THE BOUTIQUE ASKS: WHAT IS REFUSED');
  const A = T('a');
  const noTenant = await boutique('POST', '/join-request', null, owner('x'));
  check('a pass without the boutique account is refused', noTenant.status === 401, noTenant);
  const bads: [string, any, RegExp][] = [
    ['no shop name', { ...owner('x'), shopName: '' }, /shop's name/],
    ['no owner name', { ...owner('x'), ownerName: ' ' }, /owner's name/],
    ['an email that is not one', { ...owner('x'), ownerEmail: 'jyothi at gmail' }, /email address/],
    ['a mobile of 5 digits', { ...owner('x'), ownerPhone: '98480' }, /mobile/i]
  ];
  for (const [name, body, msg] of bads) {
    const r = await boutique('POST', '/join-request', A, body);
    check(`${name}: refused in words`, r.status === 400 && msg.test(r.message ?? ''), r);
  }
  check('...and nothing was saved', (await prisma.boutiqueJoinRequest.count({ where: { tenant: A } })) === 0);
  check('status before asking: NONE', (await boutique('GET', '/join-request', A)).data?.status === 'NONE');

  console.log('\nASKING, AND ASKING AGAIN');
  const a1 = await boutique('POST', '/join-request', A, { ...owner('a'), note: 'Wants the online shop before Sankranti' });
  check('asked: 201, waiting', a1.status === 201 && a1.data?.status === 'WAITING' && a1.data?.already === false, a1);
  const a2 = await boutique('POST', '/join-request', A, { ...owner('a'), city: 'Vijayawada' });
  check('asked again while waiting: 200 "already", the one card updated', a2.status === 200 && a2.data?.already === true && (await prisma.boutiqueJoinRequest.count({ where: { tenant: A } })) === 1
    && (await prisma.boutiqueJoinRequest.findFirst({ where: { tenant: A } }))?.city === 'Vijayawada', a2);
  const F = T('five');
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => boutique('POST', '/join-request', F, owner('five'))));
  check('five asks at the same moment: all answered, ONE card', five.every(r => r.status === 201 || r.status === 200) && (await prisma.boutiqueJoinRequest.count({ where: { tenant: F } })) === 1, five.map(r => r.status));
  check('the account spelled in capitals is the same account', (await boutique('POST', '/join-request', A.toUpperCase(), { ...owner('a'), city: undefined })).data?.already === true);

  console.log('\nTHE CONSOLE');
  check('the list without a Console sign-in is refused', (await consoleApi('GET', '/boutique-join-requests', undefined, false)).status === 401);
  const card = await cardFor(A);
  check('the waiting card: shop, owner, email, mobile, city, the note (kept when asked again without one), who asked', !!card && card.shopName === 'Jyothi Boutique a' && card.ownerName === 'Jyothi' && card.city === 'Vijayawada'
    && card.note === 'Wants the online shop before Sankranti' && card.requestedBy === 'CRM-B super admin' && card.status === 'WAITING', card);
  const count = await consoleApi('GET', '/boutique-join-requests/count');
  check('the menu count includes them', count.status === 200 && count.data?.waiting >= 2, count);

  console.log('\nDECLINE, THEN ASK AGAIN');
  check('decline with no reason is refused', (await consoleApi('POST', `/boutique-join-requests/${card.id}/decline`, { reason: '' })).status === 400);
  const dec = await consoleApi('POST', `/boutique-join-requests/${card.id}/decline`, { reason: 'Please call us to choose a plan first.' });
  check('declined', dec.status === 200 && dec.data?.status === 'DECLINED', dec);
  const st = await boutique('GET', '/join-request', A);
  check('the boutique sees DECLINED and why', st.data?.status === 'DECLINED' && st.data?.reason === 'Please call us to choose a plan first.', st);
  check('accepting a declined request is refused', (await consoleApi('POST', `/boutique-join-requests/${card.id}/accept`, {})).status === 409);
  check('declining it twice is refused, not a crash', (await consoleApi('POST', `/boutique-join-requests/${card.id}/decline`, { reason: 'again' })).status === 409);
  const again = await boutique('POST', '/join-request', A, owner('a'));
  check('the boutique can ask again after a decline: a new card', again.status === 201 && (await prisma.boutiqueJoinRequest.count({ where: { tenant: A } })) === 2, again);

  console.log('\nWITHDRAWING');
  const W = T('w');
  await boutique('POST', '/join-request', W, owner('w'));
  const wd = await boutique('DELETE', '/join-request', W);
  check('withdrawn by the boutique', wd.status === 200 && wd.data?.status === 'CANCELLED', wd);
  check('...gone from the Console list', !(await cardFor(W)));
  check('withdrawing again: "nothing is waiting"', (await boutique('DELETE', '/join-request', W)).status === 404);
  const wcard = await prisma.boutiqueJoinRequest.findFirst({ where: { tenant: W } });
  check('accepting a withdrawn request is refused', (await consoleApi('POST', `/boutique-join-requests/${wcard!.id}/accept`, {})).status === 409);

  console.log('\nA BOUTIQUE-ONLY CLIENT WITH STOCK: ACCEPTED');
  const J = T('jyothi');
  const linked = await boutique('POST', '/link', J, { shopName: 'Jyothi Boutique' });
  check('the boutique runs it on its own first (boutique-only shop)', linked.status === 201 && /^boutique-jointest/.test(linked.data?.clientId), linked);
  const oldClient = linked.data.clientId as string;
  const silk = await boutique('PUT', '/items/JY-SILK', J, { name: 'Kanchi silk, maroon', designGroup: 'JY-K', kind: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, purchasePrice: 280 });
  const blouse = await boutique('PUT', '/items/JY-BLOUSE', J, { name: 'Zari blouse', kind: 'READYMADE', unit: 'PIECE', sellingPrice: 1800 });
  const stores = await boutique('GET', '/stores', J);
  const loc = stores.data?.[0]?.id;
  const in1 = await boutique('POST', '/movements', J, { itemCode: 'JY-SILK', kind: 'PURCHASE', quantity: 30, locationId: loc });
  const in2 = await boutique('POST', '/movements', J, { itemCode: 'JY-BLOUSE', kind: 'PURCHASE', quantity: 4, locationId: loc });
  const hold = await boutique('POST', '/holds', J, { itemCode: 'JY-SILK', quantity: 2.5, orderRef: 'ST-77' });
  check('...with 30 m of silk, 4 blouses and 2.5 m held for a stitching order', [silk, blouse, in1, in2, hold].every(r => r.status < 300), [silk, blouse, in1, in2, hold].map(r => `${r.status} ${r.message ?? ''}`));
  await boutique('POST', '/join-request', J, owner('j'));
  const jcard = await cardFor(J);
  check('the card says what will move: 2 items, 30 m of cloth, 4 pieces', jcard?.holdings?.state === 'boutique-only' && jcard.holdings.items === 2 && jcard.holdings.metres === 30 && jcard.holdings.pieces === 4, jcard?.holdings);

  // An owner email already used by a ScaleEzy login: said on the card, refused on accept, fixable.
  const someone = await prisma.user.findFirst({ where: { status: 'ACTIVE' }, select: { email: true } });
  await prisma.boutiqueJoinRequest.updateMany({ where: { tenant: J, status: 'WAITING' }, data: { ownerEmail: someone!.email } });
  const jcard2 = await cardFor(J);
  check('an owner email already in use is flagged on the card', (jcard2?.problems ?? []).some((p: string) => /email already signs in/.test(p)), jcard2?.problems);
  const refused = await consoleApi('POST', `/boutique-join-requests/${jcard2.id}/accept`, {});
  check('...accepting it is refused in words, and nothing is made', refused.status === 409 && /email already signs in/.test(refused.message ?? ''), refused);
  const after = await prisma.boutiqueJoinRequest.findUnique({ where: { id: jcard2.id } });
  check('...the card is back to waiting, with what went wrong', after?.status === 'WAITING' && /email already signs in/.test(after?.reason ?? ''), after);
  check('...and the boutique still sees WAITING', (await boutique('GET', '/join-request', J)).data?.status === 'WAITING');

  // Two admins press Accept at the same moment, with a corrected email.
  const fixed = { ownerEmail: `jyothi-owner-${S}@example.invalid`, shopName: 'Jyothi Designer Boutique' };
  const [x, y] = await Promise.all([
    consoleApi('POST', `/boutique-join-requests/${jcard2.id}/accept`, fixed),
    consoleApi('POST', `/boutique-join-requests/${jcard2.id}/accept`, fixed)
  ]);
  const okOne = [x, y].find(r => r.status === 200);
  check('two accepts at once: one sets it up, the other is told someone is on it', !!okOne && [x.status, y.status].sort().join() === '200,409', [x.status, y.status, x.message, y.message]);
  const newClient = okOne?.data?.clientId as string;
  check('...ONE new client, with the corrected shop name', !!newClient && (await prisma.clientSettings.findUnique({ where: { clientId: newClient } }))?.businessName === 'Jyothi Designer Boutique', okOne?.data);
  const ownerUser = await prisma.user.findFirst({ where: { clientId: newClient }, select: { email: true, phone: true } });
  check('...its owner login, on the corrected email, with the mobile', ownerUser?.email === fixed.ownerEmail && !!ownerUser?.phone, ownerUser);
  check('...mail is off here, so the Console is handed the password instead', okOne?.data?.emailed === false && typeof okOne?.data?.tempPassword === 'string');
  const req = await prisma.boutiqueJoinRequest.findUnique({ where: { id: jcard2.id } });
  check('the request: ACCEPTED, with the client it became', req?.status === 'ACCEPTED' && req.clientId === newClient && !!req.decidedById, req);
  const link = await prisma.boutiqueLink.findUnique({ where: { tenant: J } });
  check('the boutique account now points at the new client', link?.clientId === newClient && !link.unlinkedAt, link);
  const moved = await prisma.productVariant.findMany({ where: { clientId: newClient, boutiqueRef: { in: ['JY-SILK', 'JY-BLOUSE'] } }, include: { stocks: true } });
  const qty = (code: string) => moved.find(v => v.boutiqueRef === code)?.stocks.reduce((t, s) => t + s.quantity, 0);
  const held = (code: string) => moved.find(v => v.boutiqueRef === code)?.stocks.reduce((t, s) => t + s.reservedQty, 0);
  check('the silk and the blouses moved in: 3000 cm and 4 pieces, 250 cm still held', moved.length === 2 && qty('JY-SILK') === 3000 && qty('JY-BLOUSE') === 4 && held('JY-SILK') === 250, moved.map(v => [v.boutiqueRef, qty(v.boutiqueRef!), held(v.boutiqueRef!)]));
  check('nothing is left in the old boutique-only shop', (await prisma.productVariant.count({ where: { clientId: oldClient } })) === 0);
  check('the history came too (the purchases)', (await prisma.inventoryTransaction.count({ where: { clientId: newClient } })) >= 2);
  const items = await boutique('GET', '/items', J);
  check('the boutique\'s NEXT call, same account, reads the new shop', items.status === 200 && (items.data?.items ?? []).length === 2, items);
  const sell = await boutique('POST', '/movements', J, { itemCode: 'JY-BLOUSE', kind: 'SALE', quantity: 1 });
  check('...and can still change stock there', sell.status < 300, sell);
  check('the boutique sees ACCEPTED', (await boutique('GET', '/join-request', J)).data?.status === 'ACCEPTED');
  check('it is on the Console\'s client list now', ((await consoleApi('GET', '/clients')).data ?? []).some((c: any) => (c.clientId ?? c.id) === newClient));
  const askAfter = await boutique('POST', '/join-request', J, owner('j'));
  check('asking again after joining: "already on ScaleEzy Inventory"', askAfter.status === 409 && /already on ScaleEzy Inventory/.test(askAfter.message ?? ''), askAfter);
  check('the waiting card is gone', !(await cardFor(J)));

  console.log('\nA CLIENT THE BOUTIQUE NEVER LINKED: ACCEPTED');
  const N = T('new');
  await boutique('POST', '/join-request', N, owner('n'));
  const ncard = await cardFor(N);
  check('its card says nothing is in the boutique yet', ncard?.holdings?.state === 'new' && ncard.holdings.items === 0, ncard?.holdings);
  const nacc = await consoleApi('POST', `/boutique-join-requests/${ncard.id}/accept`, {});
  check('accepted: a client, linked', nacc.status === 200 && (await prisma.boutiqueLink.findUnique({ where: { tenant: N } }))?.clientId === nacc.data?.clientId, nacc);
  const nst = await boutique('GET', '/stores', N);
  check('the boutique can use it straight away (its stores)', nst.status === 200 && nst.data?.length >= 1, nst);

  console.log('\nBEING SET UP');
  const B = T('busy');
  await boutique('POST', '/join-request', B, owner('b'));
  await prisma.boutiqueJoinRequest.updateMany({ where: { tenant: B, status: 'WAITING' }, data: { status: 'ACCEPTING' } });
  check('while ScaleEzy sets it up, the boutique cannot withdraw it', (await boutique('DELETE', '/join-request', B)).status === 409);
  check('...asking again is told to wait', (await boutique('POST', '/join-request', B, owner('b'))).status === 409);
  check('...and the boutique sees WAITING (not an internal word)', (await boutique('GET', '/join-request', B)).data?.status === 'WAITING');
  const bcard = await prisma.boutiqueJoinRequest.findFirst({ where: { tenant: B } });
  check('...and a second accept is turned away', (await consoleApi('POST', `/boutique-join-requests/${bcard!.id}/accept`, {})).status === 409);
}

async function cleanup() {
  const links = await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'jointest-' } }, select: { clientId: true } });
  const accepted = await prisma.boutiqueJoinRequest.findMany({ where: { tenant: { startsWith: 'jointest-' }, clientId: { not: null } }, select: { clientId: true } });
  const ids = [...new Set([...links.map(l => l.clientId), ...accepted.map(a => a.clientId!)])];
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  if (ids.length) {
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE client_id = ANY($1))`, ids).catch(() => undefined);
    for (let round = 0; round < 8; round++) {
      let left = 0;
      for (const t of tables) {
        if (t.table_name === 'boutique_join_requests') continue;
        try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; }
      }
      if (!left) break;
    }
  }
  await prisma.boutiqueJoinRequest.deleteMany({ where: { tenant: { startsWith: 'jointest-' } } });
  const users = await prisma.user.count({ where: { clientId: { in: ids } } });
  console.log(`\ncleaned up ${ids.length} clients (${users} logins left)`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
