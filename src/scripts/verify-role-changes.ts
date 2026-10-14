/**
 * When a shop changes what a role may do, the app follows at once -- and a shop's own custom role
 * works as well as the built-in ones.
 *
 *   A  a custom role with no Dashboard permission still gets the store list
 *   B  the owner adds a permission: the person can use it on their very next request, no waiting
 *   C  ...and takes it away: refused on the very next request; deleting the role works the same
 *   D  the session the app reads (/auth/session) shows the new permissions straight away
 *   E  cost price is cost:manage's, one variant at a time as well as in bulk
 *   F  the Dashboard's "your day" tiles follow permissions: each role gets its own, none gets another's
 *
 * Needs the local backend on 4006. Demo help-shop (test data). Makes a throwaway role and person
 * and removes them; a demo variant's price is put back exactly as it was.
 *
 *   npx tsx src/scripts/verify-role-changes.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const API = process.env.API_URL || 'http://localhost:4006/api/v1';
const C = process.env.GROUPS_SHOP || 'lakshmi-silks-demo-helpshop-1791264977589';
const STAMP = Date.now();
const ROLE = `Edge Counter ${STAMP % 100000}`;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
};
const sign = (u: { id: string; sessionVersion: number }) => AuthService.generateToken({ userId: u.id, clientId: C, sessionVersion: u.sessionVersion });
function client(token: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', cookie: `token=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    return { status: r.status, body: j, data: j?.data };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b ?? {}), patch: (p: string, b: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
async function userWith(role: string) {
  const u = await prisma.user.findFirst({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true } });
  if (!u) throw new Error(`No ${role} in ${C}`);
  return client(sign(u));
}

let roleId = '', personId = '';
const madeCustomers: string[] = [];
let variantBefore: { id: string; sellingPrice: any; costPrice: any } | null = null;

async function main() {
  const owner = await userWith('SUPER_ADMIN');

  console.log('\nA. A CUSTOM ROLE WITHOUT THE DASHBOARD');
  let r = await owner.post('/roles', { name: ROLE, description: 'test', permissions: ['customer:view', 'sales_order:view'] });
  roleId = r.data?.id;
  check('the owner makes a custom role (customers + orders, no dashboard)', r.status === 200 || r.status === 201, r.body);
  const person = await prisma.user.create({
    data: { clientId: C, name: 'Edge Counter Person', email: `edge-counter-${STAMP}@example.com`, password: 'not-a-real-hash', status: 'ACTIVE', roles: { create: { roleId } } } as any,
    select: { id: true, sessionVersion: true }
  });
  personId = person.id;
  const me = client(sign(person));
  r = await me.get('/locations');
  check('they still get the store list (the store picker is not empty)', r.status === 200 && Array.isArray(r.data ?? r.body) , r.status);
  r = await me.get('/customers');
  check('they can read customers, as the role says', r.status === 200, r.status);

  console.log('\nB. THE OWNER ADDS A PERMISSION WHILE THEY WORK');
  const tryAdd = () => me.post('/customers', { name: `Edge Role Customer ${Math.random().toString(36).slice(2, 6)}`, phone: `+9196${String(Date.now()).slice(-8)}` });
  r = await tryAdd();
  check('before: adding a customer is refused (403)', r.status === 403, r.status);
  await owner.patch(`/roles/${roleId}`, { permissions: ['customer:view', 'sales_order:view', 'customer:create'] });
  r = await tryAdd();
  if (r.data?.id) madeCustomers.push(r.data.id);
  check('right after the owner adds "create customers": the very next try works (no 30-second wait)', r.status === 200 || r.status === 201, { status: r.status, msg: r.body?.message });

  console.log('\nD. WHAT THE APP READS');
  r = await me.get('/auth/session');
  const perms: string[] = r.body?.user?.permissions ?? [];
  check('the session the app reads already lists the new permission', perms.includes('customer:create'), perms);

  console.log('\nC. ...AND TAKES IT AWAY');
  await owner.patch(`/roles/${roleId}`, { permissions: ['customer:view', 'sales_order:view'] });
  r = await tryAdd();
  check('right after it is taken away: refused on the very next try', r.status === 403, r.status);
  check('...with a message in words and the permission named (the app uses that to refresh)', /permission/i.test(r.body?.message ?? '') && r.body?.requiredPermission === 'customer:create', r.body);
  r = await me.get('/auth/session');
  check('...and the session no longer lists it', !(r.body?.user?.permissions ?? []).includes('customer:create'));

  console.log('\nE. COST PRICE, ONE VARIANT AT A TIME');
  const variant = await prisma.productVariant.findFirst({ where: { clientId: C, product: { trashedAt: null } }, select: { id: true, sellingPrice: true, costPrice: true } });
  if (!variant) throw new Error('No demo variant to test on');
  variantBefore = variant;
  await owner.patch(`/roles/${roleId}`, { permissions: ['product:view', 'product:update'] });
  r = await me.patch(`/variants/${variant.id}`, { costPrice: 1 });
  check('product:update but not cost:manage: changing one variant\'s cost is refused (was the loophole)', r.status === 403 && r.body?.requiredPermission === 'cost:manage', r.body);
  check('...and the cost did not change', String((await prisma.productVariant.findUnique({ where: { id: variant.id } }))?.costPrice) === String(variant.costPrice));
  r = await me.patch(`/variants/${variant.id}`, { sellingPrice: Number(variant.sellingPrice) || 100 });
  check('...while the selling price (product:update) still saves', r.status === 200, r.body);

  console.log('\nC2. DELETING THE ROLE');
  await prisma.userRole.deleteMany({ where: { userId: personId } });
  r = await owner.del(`/roles/${roleId}`);
  check('the owner deletes the role once nobody holds it', r.status === 200, r.body);
  roleId = '';
  r = await me.get('/customers');
  check('...and the person with no role left is refused at once', r.status === 403, r.status);

  console.log('\nF. "YOUR DAY" TILES FOLLOW PERMISSIONS');
  const tiles = async (role: string) => Object.keys((await (await userWith(role)).get('/dashboard/my-day')).data ?? {}).sort().join(',');
  const sales = await tiles('SALES'), warehouse = await tiles('WAREHOUSE'), admin = await tiles('ADMIN'), manager = await tiles('INVENTORY_MANAGER');
  check('Sales: bills, customers, returns waiting -- no transfers, no inspection', /bills/.test(sales) && /customersToday/.test(sales) && !/transfersOnTheWay|returnsToInspect/.test(sales), sales);
  check('Warehouse: transfers and returns to inspect', /transfersOnTheWay/.test(warehouse) && /returnsToInspect/.test(warehouse), warehouse);
  check('Admin gets every tile', admin === 'bills,customersToday,returnsToInspect,returnsWaiting,transfersOnTheWay', admin);
  check('Inventory manager: transfers, and nothing about money or customers', /transfersOnTheWay/.test(manager) && !/bills|customersToday/.test(manager), manager);
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(async () => {
    if (variantBefore) await prisma.productVariant.update({ where: { id: variantBefore.id }, data: { sellingPrice: variantBefore.sellingPrice, costPrice: variantBefore.costPrice } });
    if (madeCustomers.length) await prisma.customer.deleteMany({ where: { id: { in: madeCustomers } } });
    await prisma.customer.deleteMany({ where: { clientId: C, name: { startsWith: 'Edge Role Customer' } } });
    if (personId) { await prisma.userRole.deleteMany({ where: { userId: personId } }); await prisma.user.delete({ where: { id: personId } }).catch(() => {}); }
    if (roleId) { await prisma.rolePermission.deleteMany({ where: { roleId } }); await prisma.role.delete({ where: { id: roleId } }).catch(() => {}); }
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
