/**
 * A customer's WhatsApp offers answer, birthday, anniversary and deleting them, changed from ScaleEzy
 * CRM (29 Oct, crm-handover `profile`).
 *
 * One throwaway shop with CRM on (and one without, for a customer that is not this shop's), built here
 * and removed at the end. Real signed service tokens against the real routes:
 *   1. CRM reads and changes offers and dates, and deletes, for a named person with the app's
 *      permission (owner only for delete) -- with the app's own checks and words;
 *   2. the hand-over: while `profile` is off the app changes them as before; once on, the app's own
 *      routes refuse (offers, bulk offers, dates, delete) but other edits and CRM's calls go on, and the
 *      session tells the screens; switched back, the app works again.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> WHATSAPP_SERVICE_URL= VERIFY_API_URL=http://localhost:4016/api/v1 \
 *   CRM_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-crm-profile.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4016/api/v1';
const STAMP = Date.now();
const SHOP = `crmpf-${STAMP}`;
const OTHER = `crmpf-other-${STAMP}`;

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 300)}`;
const call = (method: string, path: string, headers: Record<string, string> = {}, data?: any) =>
  axios.request({ method, url: `${BASE}${path}`, headers, data, validateStatus: () => true, timeout: 90_000 });

const privateKey = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');
const tokenFor = (claims: { clientId?: string; userId?: string } = {}) => ({
  Authorization: `Bearer ${jwt.sign({
    sub: 'scaleezy-crm-test', scope: ['modules:crm'],
    ...(claims.clientId ? { clientId: claims.clientId } : {}),
    ...(claims.userId ? { onBehalfOf: { userId: claims.userId } } : {})
  }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`
});
const crm = (path: string) => `/internal/modules/crm/shops/${SHOP}${path}`;
const MOVED_WORDS = 'This shop changes WhatsApp offers, birthdays, anniversaries and deletes customers in ScaleEzy CRM now. Open the customer there.';

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const rolesB = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Profile Silks', timezone: 'Asia/Kolkata' } as any });
  const hash = await AuthService.hashPassword('Same-Pass-123');
  const mkUser = async (clientId: string, name: string, roleId: string) => {
    const u = await prisma.user.create({ data: { clientId, email: `${name.toLowerCase().replace(/\s/g, '')}-${STAMP}@example.com`, name, password: hash, status: 'ACTIVE' as any } });
    await prisma.userRole.create({ data: { userId: u.id, roleId } });
    return u;
  };
  const owner = await mkUser(SHOP, 'Owner Asha', roles.SUPER_ADMIN);
  const sales = await mkUser(SHOP, 'Sales Ravi', roles.SALES);
  const store = await mkUser(SHOP, 'Store Gopal', roles.WAREHOUSE);
  await mkUser(OTHER, 'Owner B', rolesB.SUPER_ADMIN);
  const app = (u: { id: string }) => ({ Authorization: `Bearer ${AuthService.generateToken({ userId: u.id, clientId: SHOP })}` });
  const asOwner = app(owner), asSales = app(sales);
  const as = (u: { id: string }) => tokenFor({ clientId: SHOP, userId: u.id });

  const on = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, tokenFor());
  check('CRM switches the shop on', on.status === 200, brief(on));
  const meena = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `C-${STAMP}`, name: 'Meena Iyer', phone: '+919848011122' } });
  const leela = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `L-${STAMP}`, name: 'Leela Rao', phone: '+919848033344' } });
  const theirs = await prisma.customer.create({ data: { clientId: OTHER, customerCode: `O-${STAMP}`, name: 'Someone Else', phone: '+919848055566' } });

  console.log('\n1. CRM CHANGES THEM, FOR A NAMED PERSON, WITH THE APP\'S RULES');
  let r = await call('GET', crm(`/customers/${meena.id}/offers`), tokenFor());
  check('CRM reads the offers answer (no person needed to read)', r.status === 200 && r.data?.data?.agreed === false, brief(r));
  r = await call('PUT', crm(`/customers/${meena.id}/offers`), tokenFor(), { agreed: true });
  check('a change with nobody named: refused', r.status === 403 && /Say who this is for/.test(r.data?.message), brief(r));
  r = await call('PUT', crm(`/customers/${meena.id}/offers`), as(store), { agreed: true });
  check('a storekeeper (no customer:update): refused, naming the permission', r.status === 403 && r.data?.message === 'That person may not do this in Inventory (needs customer:update).', brief(r));
  r = await call('PUT', crm(`/customers/${meena.id}/offers`), as(sales), { agreed: 'yes' });
  check('"yes" as text: the app\'s own words', r.status === 400 && r.data?.message === 'Say whether the customer agreed.', brief(r));
  r = await call('PUT', crm(`/customers/${meena.id}/offers`), as(sales), { agreed: true });
  let row = await prisma.customer.findUniqueOrThrow({ where: { id: meena.id } });
  check('the salesperson ticks "agrees to offers": saved, recorded as theirs', r.status === 200 && r.data?.data?.agreed === true && row.whatsappOffers === true && row.whatsappOffersBy === sales.id, brief(r));

  r = await call('PUT', crm(`/customers/${meena.id}/dates`), as(sales), { birthday: '08-14' });
  check('birthday set: 14 Aug', r.status === 200 && r.data?.data?.birthday === '08-14' && r.data?.data?.anniversary === null, brief(r));
  r = await call('PUT', crm(`/customers/${meena.id}/dates`), as(sales), { anniversary: '2019-02-29' });
  check('anniversary from a date picker: the year is dropped, the birthday is left alone', r.status === 200 && r.data?.data?.anniversary === '02-29' && r.data?.data?.birthday === '08-14', brief(r));
  r = await call('PUT', crm(`/customers/${meena.id}/dates`), as(sales), { birthday: '02-30' });
  check('30 Feb: refused in words', r.status === 400 && r.data?.message === 'That day does not exist. Check the month and day.', brief(r));
  r = await call('PUT', crm(`/customers/${meena.id}/dates`), as(sales), {});
  check('nothing to change: refused', r.status === 400 && r.data?.message === 'Send a birthday or an anniversary to change: month and day, like 08-14, or empty to clear it.', brief(r));
  r = await call('PUT', crm(`/customers/${meena.id}/dates`), as(sales), { birthday: null });
  check('birthday cleared with null', r.status === 200 && r.data?.data?.birthday === null && r.data?.data?.anniversary === '02-29', brief(r));
  r = await call('PUT', crm(`/customers/${theirs.id}/dates`), as(sales), { birthday: '01-01' });
  const theirsAfter = await prisma.customer.findUniqueOrThrow({ where: { id: theirs.id } });
  check('another shop\'s customer: 404, untouched', r.status === 404 && theirsAfter.birthday === null, brief(r));

  r = await call('GET', crm(`/customers/${leela.id}/delete-preview`), as(sales));
  check('delete preview for a salesperson: owner only', r.status === 403 && r.data?.message === 'Only the shop\'s owner can change this.', brief(r));
  r = await call('GET', crm(`/customers/${leela.id}/delete-preview`), as(owner));
  check('delete preview for the owner: removed for good, last 4 digits', r.status === 200 && r.data?.data?.mode === 'REMOVE' && r.data?.data?.phoneLast4 === '3344', brief(r));

  console.log('\n2. THE HAND-OVER');
  r = await call('PUT', `/campaigns/consent/${meena.id}`, asSales, { agreed: false });
  check('profile not moved yet: the app still changes the offers answer', r.status === 200 && r.data?.data?.agreed === false, brief(r));
  r = await call('PUT', crm('/moved'), as(owner), { profile: 'yes' });
  check('the switch takes true or false only', r.status === 400, brief(r));
  r = await call('PUT', crm('/moved'), as(sales), { profile: true });
  check('only the owner moves it', r.status === 403, brief(r));
  r = await call('PUT', crm('/moved'), as(owner), { profile: true });
  check('the owner moves offers, dates and delete to CRM', r.status === 200 && r.data?.data?.profile === true, brief(r));
  r = await call('GET', '/auth/session', asSales);
  check('the session tells the screens', r.data?.crmMoved?.profile === true, brief(r));

  r = await call('PUT', `/campaigns/consent/${meena.id}`, asSales, { agreed: true });
  check('app: ticking offers is refused, saying where', r.status === 409 && r.data?.message === MOVED_WORDS, brief(r));
  r = await call('POST', '/campaigns/consent/bulk', asOwner, { customerIds: [meena.id], confirm: true });
  check('app: marking many agreed is refused too', r.status === 409 && r.data?.message === MOVED_WORDS, brief(r));
  r = await call('PATCH', `/customers/${meena.id}`, asSales, { birthday: '05-05' });
  check('app: changing the birthday is refused', r.status === 409 && r.data?.message === MOVED_WORDS, brief(r));
  r = await call('PATCH', `/customers/${meena.id}`, asSales, { name: 'Meena S Iyer' });
  check('app: changing the name still works', r.status === 200 && r.data?.data?.name === 'Meena S Iyer', brief(r));
  r = await call('GET', `/customers/${leela.id}/delete-preview`, asOwner);
  const r2 = await call('DELETE', `/customers/${leela.id}`, asOwner, { confirm: '3344' });
  check('app: deleting is refused, and nothing is deleted', r.status === 409 && r2.status === 409 && !!(await prisma.customer.findFirst({ where: { id: leela.id, deletedAt: null } })), `${brief(r)} | ${brief(r2)}`);
  row = await prisma.customer.findUniqueOrThrow({ where: { id: meena.id } });
  check('...the refused changes left the customer as it was', row.whatsappOffers === false && row.birthday === null, { offers: row.whatsappOffers, birthday: row.birthday });

  r = await call('PUT', crm(`/customers/${meena.id}/offers`), as(sales), { agreed: true });
  const r3 = await call('PUT', crm(`/customers/${meena.id}/dates`), as(sales), { birthday: '12-25' });
  check('CRM still changes offers and dates', r.status === 200 && r3.status === 200 && r3.data?.data?.birthday === '12-25', `${brief(r)} | ${brief(r3)}`);
  r = await call('DELETE', crm(`/customers/${leela.id}`), as(owner), { confirm: '0000' });
  check('CRM delete with the wrong digits: the app\'s words', r.status === 400 && r.data?.message === 'Type the last 4 digits of their number to confirm.', brief(r));
  r = await call('DELETE', crm(`/customers/${leela.id}`), as(owner), { confirm: '3344' });
  check('CRM deletes for the owner: removed for good', r.status === 200 && r.data?.data?.mode === 'REMOVE' && (await prisma.customer.count({ where: { id: leela.id } })) === 0, brief(r));
  await new Promise(x => setTimeout(x, 800));
  const audit = await prisma.auditLog.findMany({ where: { clientId: SHOP, entityId: { in: [meena.id, leela.id] } }, select: { action: true, entityId: true, userId: true, entityType: true } });
  check('the activity log names who did it from CRM',
    audit.some(a => a.entityId === leela.id && a.action === 'CUSTOMER_DELETED' && a.userId === owner.id)
    && audit.some(a => a.entityId === meena.id && a.action === 'UPDATED' && a.entityType === 'CUSTOMER' && a.userId === sales.id), audit);
  const feed = await prisma.moduleEvent.findMany({ where: { clientId: SHOP, rowId: { in: [meena.id, leela.id] } }, select: { kind: true, rowId: true } });
  check('CRM hears back through the change feed', feed.some(e => e.rowId === meena.id && e.kind === 'customer.updated') && feed.some(e => e.rowId === leela.id && e.kind === 'customer.deleted'), feed);

  r = await call('PUT', crm('/moved'), as(owner), { profile: false });
  const s2 = await call('GET', '/auth/session', asSales);
  const r4 = await call('PATCH', `/customers/${meena.id}`, asSales, { birthday: '05-05' });
  check('given back to Inventory: the app changes them again', r.status === 200 && s2.data?.crmMoved?.profile === false && r4.status === 200, `${brief(r)} | ${brief(r4)}`);
}

async function cleanup() {
  await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [SHOP, OTHER] } } });
  for (const id of [SHOP, OTHER]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
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
