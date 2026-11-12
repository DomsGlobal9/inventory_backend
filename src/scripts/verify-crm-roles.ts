/**
 * CRM roles in Inventory (11 Nov 2026): the CRM group in the permission catalogue, the CRM twin keys on
 * CRM's internal routes, and the stores each team member works in (user.locationIds).
 *
 * Two throwaway shops (one with CRM on, one without), built here and removed at the end. Real signed
 * service tokens and app tokens against the real routes of a LOCAL server:
 *   A. the roles screen shows the CRM group (12 keys) only to the shop with CRM; roles can hold them;
 *   B. CRM's routes take the CRM key as well as Inventory's, and old roles keep working;
 *   C. Team members -> Stores: rules, and the session answer CRM reads (both routes).
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   CRM_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-crm-roles.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import * as roles from '../services/role-management';
import { PERMISSIONS } from '../config/permissions';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const STAMP = Date.now();
const SHOP = `crmroles-${STAMP}`;
const PLAIN = `crmroles-plain-${STAMP}`;
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }

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
const tokenFor = (claims: { clientId?: string; userId?: string; scope?: string[] } = {}) => ({
  Authorization: `Bearer ${jwt.sign({
    sub: 'scaleezy-crm-test', scope: claims.scope ?? ['modules:crm'],
    ...(claims.clientId ? { clientId: claims.clientId } : {}),
    ...(claims.userId ? { onBehalfOf: { userId: claims.userId } } : {})
  }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`
});
const crm = (path: string) => `/internal/modules/crm/shops/${SHOP}${path}`;
const CRM_KEYS = ['crm:sales', 'crm:customer:create', 'crm:customer:view', 'crm:customer:phone', 'crm:customer:update',
  'crm:customer:merge', 'crm:lists', 'crm:messages:view', 'crm:messages:send', 'crm:reviews', 'crm:team:view', 'crm:shop'];

async function main() {
  console.log(`SETUP ${SHOP} (CRM on) and ${PLAIN} (no CRM)`);
  const seeded = await seedRolesForClient(SHOP);
  const seededPlain = await seedRolesForClient(PLAIN);
  for (const c of [SHOP, PLAIN]) await prisma.clientSettings.create({ data: { clientId: c, businessName: `Roles ${c}`, timezone: 'Asia/Kolkata' } as any });
  const hash = await AuthService.hashPassword('Same-Pass-123');
  const mkUser = async (clientId: string, name: string, roleId: string) => {
    const u = await prisma.user.create({ data: { clientId, email: `${name.toLowerCase().replace(/\s/g, '')}-${STAMP}@example.com`, name, password: hash, status: 'ACTIVE' as any } });
    await prisma.userRole.create({ data: { userId: u.id, roleId } });
    return u;
  };
  const ownerActor: roles.Actor = { clientId: SHOP, userId: 'owner', permissions: ['*'], roles: ['SUPER_ADMIN'] };
  const plainActor: roles.Actor = { clientId: PLAIN, userId: 'owner', permissions: ['*'], roles: ['SUPER_ADMIN'] };

  const on = await call('PUT', `/internal/modules/crm/shops/${SHOP}`, tokenFor());
  check('CRM is switched on for the first shop only', on.status === 200, brief(on));

  // ── A. THE CATALOGUE ───────────────────────────────────────────────────
  console.log('\nA. THE CRM GROUP ON THE ROLES SCREEN');
  const cat = await roles.getCatalogue(ownerActor);
  const crmGroup = cat.groups.find(g => g.group === 'CRM');
  check('a shop with CRM sees a CRM group, last, with the 12 keys',
    !!crmGroup && cat.groups[cat.groups.length - 1].group === 'CRM' && crmGroup.permissions.map(p => p.key).sort().join() === [...CRM_KEYS].sort().join(),
    crmGroup?.permissions.map(p => p.key));
  check('every CRM key carries CRM\'s own sentence', crmGroup?.permissions.find(p => p.key === 'crm:sales')?.label === 'Use the Shop floor: take walk-ins, show pieces, record what they tried and bought'
    && crmGroup?.permissions.find(p => p.key === 'crm:customer:phone')?.label === 'See full phone numbers', '');
  check('the owner can tick every CRM box', !!crmGroup && crmGroup.permissions.every(p => p.grantable));
  const plainCat = await roles.getCatalogue(plainActor);
  check('a shop without CRM: no CRM group, the six Inventory groups as before',
    !plainCat.groups.some(g => g.group === 'CRM') && plainCat.groups.length === 6, plainCat.groups.map(g => g.group));
  check('no Inventory group gained or lost a key', plainCat.groups.reduce((n, g) => n + g.permissions.length, 0) === PERMISSIONS.length - CRM_KEYS.length);
  const viaApiOwner = await prisma.user.create({ data: { clientId: SHOP, email: `api-owner-${STAMP}@example.com`, name: 'Owner Asha', password: hash, status: 'ACTIVE' as any } });
  await prisma.userRole.create({ data: { userId: viaApiOwner.id, roleId: seeded.SUPER_ADMIN } });
  const app = (u: { id: string }, clientId = SHOP) => ({ Authorization: `Bearer ${AuthService.generateToken({ userId: u.id, clientId })}` });
  let r = await call('GET', '/roles/catalogue', app(viaApiOwner));
  check('the roles screen\'s own request shows the CRM group', r.status === 200 && r.data?.data?.groups?.some((g: any) => g.group === 'CRM'), brief(r));

  const floor = await roles.createRole(ownerActor, { name: `Floor ${STAMP}`, permissions: ['crm:sales', 'crm:customer:create'] });
  const listed = (await roles.listRoles(ownerActor)).find(x => x.id === floor.id)!;
  check('a role made of CRM boxes only is saved as ticked', listed.permissions.sort().join() === 'crm:customer:create,crm:sales', listed.permissions);
  check('and confers seeing customers in CRM (implied), nothing in Inventory',
    listed.effectivePermissions.includes('crm:customer:view') && !listed.effectivePermissions.some(k => !k.startsWith('crm:')), listed.effectivePermissions);
  let refused: any = null;
  try { await roles.createRole(ownerActor, { name: `Typo ${STAMP}`, permissions: ['crm:nonsense'] }); } catch (e) { refused = e; }
  check('a key CRM does not have is refused', refused?.statusCode === 400 && /not things this product can do/.test(refused?.message), refused?.message);
  const manager = await roles.createRole(ownerActor, { name: `Mgr ${STAMP}`, permissions: ['customer:view', 'admin:users'] });
  const mgrUser = await mkUser(SHOP, 'Manager Kiran', manager.id);
  refused = null;
  try { await roles.createRole({ clientId: SHOP, userId: mgrUser.id, permissions: ['customer:view', 'admin:users'], roles: [`Mgr ${STAMP}`] }, { name: `Up ${STAMP}`, permissions: ['crm:messages:send'] }); } catch (e) { refused = e; }
  check('someone without a CRM key cannot hand it out', refused?.statusCode === 403, refused?.message);

  // ── B. CRM'S ROUTES TAKE THE CRM KEYS ──────────────────────────────────
  console.log('\nB. CRM\'S ROUTES TAKE THE CRM KEYS, AND OLD ROLES STILL WORK');
  const floorUser = await mkUser(SHOP, 'Floor Priya', floor.id);
  const writer = await roles.createRole(ownerActor, { name: `Writer ${STAMP}`, permissions: ['crm:customer:create', 'crm:customer:update'] });
  const writerUser = await mkUser(SHOP, 'Writer Divya', writer.id);
  const reviewer = await roles.createRole(ownerActor, { name: `Reviews ${STAMP}`, permissions: ['crm:reviews'] });
  const reviewerUser = await mkUser(SHOP, 'Reviews Latha', reviewer.id);
  const lister = await roles.createRole(ownerActor, { name: `Lists ${STAMP}`, permissions: ['crm:lists'] });
  const listerUser = await mkUser(SHOP, 'Lists Arun', lister.id);
  const sales = await mkUser(SHOP, 'Sales Ravi', seeded.SALES);
  const store = await mkUser(SHOP, 'Store Gopal', seeded.WAREHOUSE);
  const as = (u: { id: string }) => tokenFor({ clientId: SHOP, userId: u.id });

  r = await call('POST', crm('/customers'), as(floorUser), { name: 'Kavya Nair', phone: '9000022001', offers: true });
  check('a CRM-only salesperson adds a customer', r.status === 200 && r.data?.data?.name === 'Kavya Nair', brief(r));
  check('without "change consent" their yes to offers is not recorded, and CRM is told why',
    r.status === 200 && r.data?.data?.offers === 'Changing a customer is not part of your role.', r.data?.data?.offers);
  const kavya = r.data?.data?.id;
  r = await call('POST', crm('/customers'), as(writerUser), { name: 'Rekha Shetty', phone: '9000022002', offers: true });
  const rekha = r.status === 200 ? await prisma.customer.findUnique({ where: { id: r.data.data.id } }) : null;
  check('with crm:customer:update the yes is saved, as theirs', r.status === 200 && r.data?.data?.offers === 'saved' && rekha?.whatsappOffers === true && rekha?.whatsappOffersBy === writerUser.id, brief(r));
  r = await call('POST', crm('/customers'), as(sales), { name: 'Old Role Sita', phone: '9000022003' });
  check('the old SALES role (customer:create) still adds customers', r.status === 200, brief(r));
  r = await call('POST', crm('/customers'), as(store), { name: 'Nope', phone: '9000022004' });
  check('a storekeeper is refused, naming both keys', r.status === 403 && r.data?.message === 'That person may not do this in Inventory (needs customer:create or crm:customer:create).', brief(r));
  r = await call('POST', crm('/customers'), as(floorUser), { name: 'Kavya Again', phone: '9000022001' });
  check('the same number again: 409, naming who has it', r.status === 409 && r.data?.details?.existingCustomerId === kavya, brief(r));

  r = await call('PUT', crm(`/customers/${kavya}/offers`), as(writerUser), { agreed: true });
  check('crm:customer:update changes the offers answer', r.status === 200 && r.data?.data?.agreed === true, brief(r));
  r = await call('PUT', crm(`/customers/${kavya}/dates`), as(writerUser), { birthday: '03-09' });
  check('crm:customer:update changes the birthday', r.status === 200 && r.data?.data?.birthday === '03-09', brief(r));
  r = await call('PUT', crm(`/customers/${kavya}/offers`), as(reviewerUser), { agreed: false });
  check('crm:reviews alone may not change consent', r.status === 403, brief(r));
  r = await call('PUT', crm(`/customers/${kavya}/offers`), as(sales), { agreed: false });
  check('the old SALES role still changes consent', r.status === 200 && r.data?.data?.agreed === false, brief(r));

  r = await call('POST', crm('/groups'), as(listerUser), { name: `VIP ${STAMP % 1000}` });
  check('crm:lists makes a customer group', r.status === 200, brief(r));
  r = await call('POST', crm('/groups'), as(writerUser), { name: 'Nope group' });
  check('crm:customer:update alone may not', r.status === 403, brief(r));
  r = await call('GET', crm('/groups'), as(floorUser));
  check('crm:sales (implies seeing customers) can read groups', r.status === 200, brief(r));
  r = await call('GET', crm('/groups'), as(store));
  check('a storekeeper cannot read customer groups', r.status === 403, brief(r));
  r = await call('POST', crm('/reviews/00000000-0000-0000-0000-000000000000/hide'), as(reviewerUser), { reason: 'SPAM' });
  check('crm:reviews gets past the door to hide a review (404: no such review)', r.status === 404, brief(r));
  r = await call('POST', crm('/reviews/00000000-0000-0000-0000-000000000000/hide'), as(listerUser), { reason: 'SPAM' });
  check('crm:lists may not hide reviews', r.status === 403, brief(r));

  // ── C. STORES ────────────────────────────────────────────────────────────
  console.log('\nC. WHICH STORES A PERSON WORKS IN');
  const mk = (clientId: string, name: string, type: string, active = true) =>
    prisma.stockLocation.create({ data: { clientId, name, code: `${name.replace(/\W/g, '').toUpperCase()}-${STAMP}`, type: type as any, active } });
  const north = await mk(SHOP, 'North Branch', 'STORE');
  const south = await mk(SHOP, 'South Branch', 'STORE');
  const godown = await mk(SHOP, 'Godown', 'WAREHOUSE');
  const online = await mk(SHOP, 'Online', 'ONLINE');
  const closed = await mk(SHOP, 'Old Branch', 'STORE', false);
  const elsewhere = await mk(PLAIN, 'Their Store', 'STORE');
  const team = (u: { id: string }) => `/team/members/${u.id}/stores`;
  const owner = app(viaApiOwner);

  r = await call('GET', '/team/members', owner);
  check('Team members lists everyone with locationIds [] (all stores) to start',
    r.status === 200 && r.data?.data?.every((m: any) => Array.isArray(m.locationIds) && m.locationIds.length === 0), brief(r));
  r = await call('PATCH', team(floorUser), owner, { locationIds: [north.id, godown.id, north.id] });
  check('the owner gives Priya North Branch and the godown (a repeat counted once)',
    r.status === 200 && r.data?.data?.locationIds?.join() === [north.id, godown.id].join(), brief(r));
  let s = await call('GET', '/auth/session', app(floorUser));
  check('her session says locationIds = those two', s.status === 200 && s.data?.user?.locationIds?.join() === [north.id, godown.id].join(), brief(s));
  const sigIn = await call('POST', '/internal/session', tokenFor({ scope: ['modules:crm', 'session:read'] }), { token: AuthService.generateToken({ userId: floorUser.id, clientId: SHOP }) });
  check('CRM\'s own session request gives the same locationIds and the CRM keys',
    sigIn.status === 200 && sigIn.data?.user?.locationIds?.join() === [north.id, godown.id].join()
      && sigIn.data?.user?.permissions?.includes('crm:sales') && sigIn.data?.user?.permissions?.includes('crm:customer:view'), brief(sigIn));
  s = await call('GET', '/auth/session', app(sales));
  check('someone never given stores: [] (all stores)', s.status === 200 && Array.isArray(s.data?.user?.locationIds) && s.data.user.locationIds.length === 0, brief(s));

  r = await call('PATCH', team(floorUser), owner, { locationIds: [online.id] });
  check('the Online location cannot be chosen', r.status === 400, brief(r));
  r = await call('PATCH', team(floorUser), owner, { locationIds: [closed.id] });
  check('a closed store cannot be chosen', r.status === 400, brief(r));
  r = await call('PATCH', team(floorUser), owner, { locationIds: [elsewhere.id] });
  check('another shop\'s store cannot be chosen', r.status === 400, brief(r));
  r = await call('PATCH', team(floorUser), owner, { locationIds: 'north' });
  check('not a list: refused in words', r.status === 400 && /list/.test(r.data?.message), brief(r));
  r = await call('PATCH', team(floorUser), owner, { locationIds: ['nope-id'] });
  check('a made-up id: refused', r.status === 400, brief(r));
  const still = await prisma.user.findUniqueOrThrow({ where: { id: floorUser.id }, select: { locationIds: true } });
  check('none of the refusals changed her stores', still.locationIds.join() === [north.id, godown.id].join(), still.locationIds);
  r = await call('PATCH', team(viaApiOwner), owner, { locationIds: [south.id] });
  check('nobody changes their own stores', r.status === 403, brief(r));
  r = await call('PATCH', team(floorUser), app(sales), { locationIds: [south.id] });
  check('a salesperson cannot set anyone\'s stores', r.status === 403, brief(r));
  r = await call('PATCH', team(floorUser), app(mgrUser), { locationIds: [south.id] });
  check('a manager with less access than Priya (no CRM keys) cannot set hers', r.status === 403, brief(r));
  const plainOwner = await mkUser(PLAIN, 'Owner Other', seededPlain.SUPER_ADMIN);
  r = await call('PATCH', team(sales), app(plainOwner, PLAIN), { locationIds: [] });
  check('the other shop\'s owner cannot touch this shop\'s people (not found there)', r.status === 404, brief(r));
  r = await call('PATCH', team(floorUser), owner, { locationIds: [] });
  s = await call('GET', '/auth/session', app(floorUser));
  check('back to all stores: [] again', r.status === 200 && s.data?.user?.locationIds?.length === 0, brief(s));

  // ── D. SHOP FLOOR: THE DOOR QR AND CLOSING A WALK-IN, THROUGH CRM'S ROUTES ─────────
  console.log('\nD. DOOR QR AND "NOT HERE", THROUGH CRM\'S ROUTES');
  r = await call('GET', crm(`/door-qr?locationId=${north.id}`), tokenFor());
  check('the door QR for a store: shop, store, message; WhatsApp not linked -> no link, the reason to show',
    r.status === 200 && r.data?.data?.store === 'North Branch' && r.data?.data?.link === null && r.data?.data?.fix === 'WHATSAPP' && typeof r.data?.data?.reason === 'string', brief(r));
  r = await call('GET', crm(`/door-qr?locationId=${elsewhere.id}`), tokenFor());
  check('another shop\'s store: refused, no QR', r.status >= 400 && !r.data?.data?.link, brief(r));
  r = await call('GET', crm('/door-qr'), tokenFor());
  check('no store named: refused in words', r.status === 400, brief(r));
  r = await call('GET', crm(`/door-qr?locationId=${north.id}`), as(store));
  check('a storekeeper named as the person: refused (no customer keys)', r.status === 403, brief(r));

  const arrival = await prisma.storeCheckin.create({ data: { clientId: SHOP, locationId: north.id, phone: '+919000055001' } });
  const close = (who: { id: string }, body: any, id = arrival.id) => call('POST', crm(`/checkins/${id}/close`), as(who), body);
  r = await close(store, { as: 'LEFT' });
  check('a storekeeper cannot close a walk-in', r.status === 403, brief(r));
  r = await close(floorUser, { as: 'BYE' });
  check('a wrong "as": refused in words', r.status === 400 && /LEFT or MISTAKE/.test(r.data?.message), brief(r));
  r = await call('POST', crm(`/checkins/${arrival.id}/close`), tokenFor(), { as: 'LEFT' });
  check('nobody named: refused', r.status === 403, brief(r));
  r = await close(floorUser, { as: 'LEFT' });
  let a1 = await prisma.storeCheckin.findUniqueOrThrow({ where: { id: arrival.id } });
  check('crm:sales closes a walk-in nobody has taken: LEFT, by Priya', r.status === 200 && r.data?.data?.closedAs === 'LEFT' && a1.closedByName === 'Floor Priya' && !!a1.doneAt, brief(r));
  r = await call('POST', crm(`/checkins/${arrival.id}/reopen`), as(writerUser));
  check('someone else cannot undo Priya\'s "Not here"', r.status === 403, brief(r));
  r = await call('POST', crm(`/checkins/${arrival.id}/reopen`), as(floorUser));
  a1 = await prisma.storeCheckin.findUniqueOrThrow({ where: { id: arrival.id } });
  check('Priya undoes it: waiting again', r.status === 200 && a1.doneAt === null && a1.closedAs === null, brief(r));
  r = await close(floorUser, { as: 'LEFT' }, '00000000-0000-0000-0000-000000000000');
  check('an arrival that does not exist: 404', r.status === 404, brief(r));
  const theirs = await prisma.storeCheckin.create({ data: { clientId: PLAIN, locationId: elsewhere.id, phone: '+919000055002' } });
  r = await close(floorUser, { as: 'LEFT' }, theirs.id);
  const theirsAfter = await prisma.storeCheckin.findUniqueOrThrow({ where: { id: theirs.id } });
  check('another shop\'s arrival: not found, untouched', r.status === 404 && theirsAfter.doneAt === null, brief(r));
  await prisma.storeCheckin.update({ where: { id: arrival.id }, data: { takenAt: new Date(), takenById: writerUser.id, takenByName: 'Writer Divya' } });
  r = await close(floorUser, { as: 'LEFT' });
  check('a walk-in Divya has taken: Priya cannot close it', r.status === 403 && /Writer Divya is with them/.test(r.data?.message), brief(r));
  r = await close(viaApiOwner, { as: 'MISTAKE' });
  check('the owner can (a visit left open at closing time)', r.status === 200 && r.data?.data?.closedAs === 'MISTAKE', brief(r));
  await prisma.storeCheckin.deleteMany({ where: { id: { in: [arrival.id, theirs.id] } } });
}

async function cleanup() {
  await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [SHOP, PLAIN] } } });
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [SHOP, PLAIN] } } });
  for (const id of [SHOP, PLAIN]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  const left = await prisma.user.count({ where: { clientId: { in: [SHOP, PLAIN] } } });
  check('nothing left behind', left === 0, `${left} users`);
}

main()
  .catch(e => { failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => { failures.push(`cleanup crashed: ${e?.message}`); console.error(e); });
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
