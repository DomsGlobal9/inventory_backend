/**
 * The module outbox and the service routes CRM uses (28 Oct).
 *
 * A throwaway shop switched on for CRM, a second one that is not, and a stand-in CRM inbox on a local
 * port that checks every signature. The changes are made the real way (API calls, a real order), the
 * events are written by the database triggers, and the dispatcher sends them.
 *
 * Needs the local server started with TRUSTED_SERVICES_KEYS registering the test key (launch config
 * backend-localdb) and CRM_KEY_DIR pointing at the matching private key.
 *
 *   VERIFY_API_URL=http://localhost:4016/api/v1 CRM_KEY_DIR=<dir> npx tsx src/scripts/verify-module-outbox.ts
 */
import axios from 'axios';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { ModuleOutboxDispatcher } from '../services/module-outbox';
import { signedMaterial } from '../utils/storefrontSignature';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const KEY_DIR = process.env.CRM_KEY_DIR!;
const STAMP = Date.now();
const SHOP = `outbox-${STAMP}`;
const OTHER = `outbox-other-${STAMP}`;
const SECRET = crypto.randomBytes(24).toString('hex');

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 220)}`;
const call = (method: string, path: string, headers: Record<string, string> = {}, data?: any) =>
  axios.request({ method, url: `${BASE}${path}`, headers, data, validateStatus: () => true, timeout: 60_000 });

const privateKey = fs.readFileSync(`${KEY_DIR}/private.pem`, 'utf8');
const serviceToken = (scope: string[], opts: { iss?: string; kid?: string; aud?: string; key?: string } = {}) =>
  jwt.sign({ sub: 'scaleezy-crm-test', scope }, opts.key ?? privateKey, {
    algorithm: 'RS256', audience: opts.aud ?? 'inventory', issuer: opts.iss ?? 'scaleezy-crm-test', keyid: opts.kid ?? 'test-1', expiresIn: '5m'
  });
const CRM = { Authorization: `Bearer ${serviceToken(['session:read', 'modules:crm'])}` };

// The stand-in CRM inbox. `mode` decides how it answers; every request's signature is checked.
const inbox = { mode: 'ok' as 'ok' | 'fail', batches: [] as any[], badSignatures: 0, deliveryIds: [] as string[] };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const ts = Number(req.headers['x-inventory-timestamp']);
    const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(signedMaterial(ts, raw), 'utf8').digest('hex');
    const sig = String(req.headers['x-inventory-signature'] ?? '');
    const fresh = Math.abs(Date.now() / 1000 - ts) <= 300;
    if (!fresh || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      inbox.badSignatures++; res.statusCode = 401; return res.end('bad signature');
    }
    inbox.deliveryIds.push(String(req.headers['x-inventory-delivery-id']));
    if (inbox.mode === 'fail') { res.statusCode = 503; return res.end('down for a moment'); }
    inbox.batches.push(JSON.parse(raw));
    res.statusCode = 200; res.end('{"ok":true}');
  });
});

const eventsOf = (clientId: string) => prisma.moduleEvent.findMany({ where: { clientId }, orderBy: { sequence: 'asc' } });

async function main() {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  process.env.CRM_EVENTS_URL = `http://127.0.0.1:${port}/inbox`;
  process.env.CRM_EVENTS_SECRET = SECRET;

  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const rolesB = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Outbox Silks' } });
  await prisma.clientSettings.create({ data: { clientId: OTHER, businessName: 'Other Sarees' } });
  const hash = await AuthService.hashPassword('Same-Pass-123');
  const email = `owner-${STAMP}@example.com`;
  const owner = await prisma.user.create({ data: { clientId: SHOP, email, name: 'Owner', password: hash, status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
  const ownerB = await prisma.user.create({ data: { clientId: OTHER, email, name: 'Owner B', password: hash, status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: ownerB.id, roleId: rolesB.SUPER_ADMIN } });
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const token = AuthService.generateToken({ userId: owner.id, clientId: SHOP });
  const tokenB = AuthService.generateToken({ userId: ownerB.id, clientId: OTHER });
  const asOwner = { Authorization: `Bearer ${token}`, 'x-location-id': store.id };

  console.log('\n1. ONLY CRM, PROPERLY SIGNED, GETS IN');
  const none = await call('POST', '/internal/session', {}, { token });
  check('no service token: 401', none.status === 401, brief(none));
  const human = await call('POST', '/internal/session', { Authorization: `Bearer ${token}` }, { token });
  check('a person\'s own login token is not a service token: 401', human.status === 401, brief(human));
  const strangerKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const forged = await call('POST', '/internal/session', { Authorization: `Bearer ${serviceToken(['session:read'], { key: strangerKey })}` }, { token });
  check('signed with a key Inventory does not know: 401', forged.status === 401, brief(forged));
  const wrongAud = await call('POST', '/internal/session', { Authorization: `Bearer ${serviceToken(['session:read'], { aud: 'crm' })}` }, { token });
  check('meant for another audience: 401', wrongAud.status === 401, brief(wrongAud));
  const noScope = await call('POST', '/internal/session', { Authorization: `Bearer ${serviceToken(['modules:crm'])}` }, { token });
  check('without the session:read scope: 403', noScope.status === 403, brief(noScope));
  const otherModule = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, { Authorization: `Bearer ${serviceToken(['modules:finance'])}` });
  check('a service for Finance cannot switch a shop on for CRM: 403', otherModule.status === 403, brief(otherModule));
  const noSuch = await call('PUT', `/internal/modules/nothing/shops/${SHOP}`, { Authorization: `Bearer ${serviceToken(['modules:nothing'])}` });
  check('an unknown module: 404', noSuch.status === 404, brief(noSuch));

  console.log('\n2. WHO IS THIS? (CRM\'s sign-in check)');
  const own = await call('GET', '/auth/session', { Authorization: `Bearer ${token}` });
  const viaCrm = await call('POST', '/internal/session', CRM, { token });
  check('the same answer the app gets: same person, same shop, same permissions', viaCrm.status === 200 && JSON.stringify(viaCrm.data) === JSON.stringify(own.data) && viaCrm.data.client.id === SHOP, `${brief(viaCrm)} | ${brief(own)}`);
  const junk = await call('POST', '/internal/session', CRM, { token: 'not-a-token' });
  check('a made-up user token: 401', junk.status === 401, brief(junk));
  const empty = await call('POST', '/internal/session', CRM, {});
  check('no user token sent: 400 with a plain sentence', empty.status === 400 && /token/.test(empty.data?.message ?? ''), brief(empty));
  await prisma.user.update({ where: { id: ownerB.id }, data: { sessionVersion: { increment: 1 } } });
  const ended = await call('POST', '/internal/session', CRM, { token: tokenB });
  check('a sign-in that has ended (signed out everywhere): 401', ended.status === 401, brief(ended));
  // Switched off the real way: the owner does it in Team, which also clears the remembered identity.
  const staff = await prisma.user.create({ data: { clientId: SHOP, email: `staff-${STAMP}@example.com`, name: 'Staff', password: hash, status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: staff.id, roleId: roles.SALES } });
  const staffToken = AuthService.generateToken({ userId: staff.id, clientId: SHOP });
  const liveStaff = await call('POST', '/internal/session', CRM, { token: staffToken });
  const switchOff = await call('PATCH', `/team/members/${staff.id}/status`, { Authorization: `Bearer ${token}` }, { status: 'INACTIVE' });
  const off = await call('POST', '/internal/session', CRM, { token: staffToken });
  check('a team member switched off in Team: CRM is told at once (401), though a moment ago it was 200', liveStaff.status === 200 && switchOff.status === 200 && off.status === 401, `${brief(liveStaff)} | ${brief(switchOff)} | ${brief(off)}`);
  const burst = await Promise.all(Array.from({ length: 130 }, () => call('POST', '/internal/session', CRM, { token })));
  const limited = burst.filter(r => r.status === 429).length;
  check('130 checks in a moment from one address: none refused (not in the 100-per-address limit)', limited === 0 && burst.every(r => r.status === 200), `${limited} refused`);

  console.log('\n3. ONLY A SWITCHED-ON SHOP PRODUCES EVENTS');
  const before = await call('POST', '/customers', asOwner, { name: 'Before Switch', phone: `+9170${String(STAMP).slice(-8)}` });
  check('a change before the shop is switched on: no event', before.status < 300 && (await eventsOf(SHOP)).length === 0, brief(before));
  const on = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, CRM);
  const again = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, CRM);
  const list = await call('GET', '/internal/modules/crm/shops', CRM);
  check('CRM switches the shop on (twice is harmless) and sees it in its list', on.status === 200 && again.status === 200 && list.data?.data?.some((s: any) => s.clientId === SHOP), `${brief(on)} | ${brief(list)}`);

  const created = await call('POST', '/customers', asOwner, { name: 'Asha Rao', phone: `+9171${String(STAMP).slice(-8)}`, email: `asha-${STAMP}@example.com` });
  const customerId = created.data?.data?.id ?? created.data?.id;
  const edited = await call('PATCH', `/customers/${customerId}`, asOwner, { name: 'Asha R. Rao' });
  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Ilkal Saree', productCode: `OB-${STAMP}`, slug: `ob-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 2000, status: 'ACTIVE' } });
  const variant = await prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, sku: `OB-RED-${STAMP}`, variantCode: `V-OB-${STAMP}`, colorName: 'Red', size: 'Free Size', sellingPrice: 2000, costPrice: 1200, averageCost: 1200 } });
  await call('POST', '/inventory/stock-in', asOwner, { variantId: variant.id, quantity: 5, reason: 'PURCHASE', unitCost: 1200, locationId: store.id });
  const quote = await call('POST', '/pricing/quote', asOwner, { locationId: store.id, channel: 'POS', customerId, lines: [{ variantId: variant.id, quantity: 2 }] });
  const order = await call('POST', '/sales-orders/full', asOwner, { locationId: store.id, quoteId: quote.data?.data?.quoteId, customer: { id: customerId }, items: [{ variantId: variant.id, quantity: 2 }], status: 'CONFIRMED' });
  const orderId = order.data?.id ?? order.data?.data?.id;
  check('the changes themselves worked (customer added and edited, order placed)', !!customerId && edited.status < 300 && !!orderId, `${brief(created)} | ${brief(edited)} | ${brief(order)}`);

  const evs = await eventsOf(SHOP);
  const kinds = evs.map(e => e.kind);
  check('customer.created for Asha, with her name and phone in it', evs.some(e => e.kind === 'customer.created' && (e.payload as any).id === customerId && (e.payload as any).name === 'Asha Rao'), kinds.join(','));
  check('customer.updated with the new name', evs.some(e => e.kind === 'customer.updated' && (e.payload as any).name === 'Asha R. Rao'), kinds.join(','));
  check('sale.created for the order, and sale_line.created for its line', evs.some(e => e.kind === 'sale.created' && e.rowId === orderId) && evs.some(e => e.kind === 'sale_line.created' && (e.payload as any).sales_order_id === orderId), kinds.join(','));
  check('every event is the shop\'s own, for crm, waiting to be sent', evs.length > 0 && evs.every(e => e.clientId === SHOP && e.module === 'crm' && e.status === 'PENDING'), JSON.stringify(evs.map(e => [e.clientId, e.module, e.status])));
  await call('POST', '/customers', { Authorization: `Bearer ${AuthService.generateToken({ userId: ownerB.id, clientId: OTHER, sessionVersion: 1 })}` }, { name: 'Not Switched On', phone: `+9172${String(STAMP).slice(-8)}` });
  check('the other shop (not switched on) produced nothing', (await eventsOf(OTHER)).length === 0);

  console.log('\n4. DELIVERY: SIGNED, IN ORDER, RETRIED');
  inbox.mode = 'fail';
  const r1 = await ModuleOutboxDispatcher.runOnce({ onlyClients: [SHOP, OTHER] });
  const afterFail = await eventsOf(SHOP);
  check('CRM down: the batch waits to retry, attempt counted, next try in the future', r1.failed > 0 && afterFail.every(e => e.status === 'RETRYING' && e.attempts === 1 && e.nextAttemptAt && e.nextAttemptAt > new Date()), JSON.stringify(afterFail.map(e => [e.status, e.attempts])));
  check('...and the inbox saw a correctly signed request', inbox.badSignatures === 0 && inbox.deliveryIds.length === 1, `${inbox.badSignatures} bad, ${inbox.deliveryIds.length} sent`);
  const newer = await call('PATCH', `/customers/${customerId}`, asOwner, { name: 'Asha Rao Kumar' });
  inbox.mode = 'ok';
  const r2 = await ModuleOutboxDispatcher.runOnce({ onlyClients: [SHOP, OTHER] });
  check('a newer change does not overtake the waiting batch: nothing sent while it is not due', newer.status < 300 && r2.batches === 0 && inbox.batches.length === 0, JSON.stringify(r2));
  await prisma.moduleEvent.updateMany({ where: { clientId: SHOP, status: 'RETRYING' }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  const r3 = await ModuleOutboxDispatcher.runOnce({ onlyClients: [SHOP, OTHER] });
  check('when due, the same batch goes again with the same delivery id', r3.delivered > 0 && inbox.deliveryIds[1] === inbox.deliveryIds[0], JSON.stringify(inbox.deliveryIds));
  await ModuleOutboxDispatcher.runOnce({ onlyClients: [SHOP, OTHER] });
  const sent = inbox.batches.flatMap(b => b.events);
  const seqs = sent.map((e: any) => BigInt(e.sequence));
  check('everything arrived, oldest first, each once', sent.length === (await eventsOf(SHOP)).length && seqs.every((s, i) => i === 0 || s > seqs[i - 1]) && new Set(sent.map((e: any) => e.id)).size === sent.length, `${sent.length} sent`);
  check('each batch names its shop and module, and the newest name arrived last', inbox.batches.every(b => b.clientId === SHOP && b.module === 'crm' && b.source === 'inventory') && sent.filter((e: any) => e.kind === 'customer.updated').pop()?.payload?.name === 'Asha Rao Kumar', JSON.stringify(inbox.batches.map(b => [b.clientId, b.module])));
  check('all marked delivered; no bad signatures at all', (await eventsOf(SHOP)).every(e => e.status === 'DELIVERED' && e.deliveredAt) && inbox.badSignatures === 0);

  console.log('\n5. CATCHING UP, SWITCHING OFF');
  const all = await call('GET', `/internal/modules/crm/shops/${SHOP}/events?after=0&limit=500`, CRM);
  const last = all.data?.data?.slice(-1)[0]?.sequence;
  const tail = await call('GET', `/internal/modules/crm/shops/${SHOP}/events?after=${last}`, CRM);
  const bad = await call('GET', `/internal/modules/crm/shops/${SHOP}/events?after=-1`, CRM);
  check('the feed can be read back after any number, oldest first; nothing after the last; bad input 400', all.status === 200 && all.data.data.length === sent.length && tail.data?.data?.length === 0 && bad.status === 400, `${brief(all)} | ${brief(bad)}`);
  delete process.env.CRM_EVENTS_URL;
  await call('PATCH', `/customers/${customerId}`, asOwner, { name: 'Waiting Name' });
  await ModuleOutboxDispatcher.runOnce({ onlyClients: [SHOP, OTHER] });
  const waiting = (await eventsOf(SHOP)).filter(e => e.status !== 'DELIVERED');
  check('with no CRM address configured, events wait and no attempts are spent', waiting.length > 0 && waiting.every(e => e.status === 'PENDING' && e.attempts === 0), JSON.stringify(waiting.map(e => [e.status, e.attempts])));
  const offRes = await call('DELETE', `/internal/modules/crm/shops/${SHOP}`, CRM);
  await call('PATCH', `/customers/${customerId}`, asOwner, { name: 'After Off' });
  const afterOff = await eventsOf(SHOP);
  check('switched off: what was waiting is cancelled, and new changes produce nothing', offRes.status === 200 && offRes.data.data.cancelled === waiting.length && afterOff.filter(e => e.status === 'CANCELLED').length === waiting.length && afterOff.length === sent.length + waiting.length, `${brief(offRes)} | ${afterOff.length}`);

  console.log('\n6. SHOP NAMES WHEN ONE EMAIL HAS TWO SHOPS');
  const login = await call('POST', '/auth/login', { 'Content-Type': 'application/json' }, { email, password: 'Same-Pass-123' });
  const ws = login.data?.workspaces ?? [];
  check('the "which shop?" answer gives both shops by name', login.data?.requiresWorkspaceSelection === true && ws.length === 2 && ws.some((w: any) => w.clientId === SHOP && w.businessName === 'Outbox Silks') && ws.some((w: any) => w.clientId === OTHER && w.businessName === 'Other Sarees'), brief(login));
}

async function cleanup() {
  server.close();
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  for (const id of [SHOP, OTHER]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  // Deleting the shops' rows fires the triggers once more; the subscription is already gone, so nothing is written.
  const left = await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER] } } }) + await prisma.moduleEvent.count({ where: { clientId: { in: [SHOP, OTHER] } } });
  check('both throwaway shops and their events are gone', left === 0, String(left));
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
