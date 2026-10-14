/**
 * Two things, through the real API on a demo help-shop (test data):
 *
 *   A  adding a team member takes their mobile, stored the app's one way; a bad number is refused in words
 *   B  "send login on WhatsApp": asks for a number when there is none, saves one typed, refuses an
 *      Admin sending a Super Admin's login, and says in words when the shop's WhatsApp is not connected
 *   C  customer:manage_groups: Sales (customer:update only) may put customers in a group but not change
 *      its rules, name, merge or delete it; Admin may; every shop's ADMIN holds the new permission
 *
 * Needs the local backend on 4006. Nothing is sent to a real phone: the demo shop has no connected
 * WhatsApp, which is exactly the refusal B checks. Removes the people and groups it made.
 *
 *   npx tsx src/scripts/verify-team-whatsapp-and-groups-permission.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const API = process.env.API_URL || 'http://localhost:4006/api/v1';
const C = process.env.GROUPS_SHOP || 'lakshmi-silks-demo-helpshop-1791264977589';
const STAMP = Date.now();
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
};
async function as(role: string) {
  const u = await prisma.user.findFirst({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true } });
  if (!u) throw new Error(`No ${role}`);
  const token = AuthService.generateToken({ userId: u.id, clientId: C, sessionVersion: u.sessionVersion });
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', cookie: `token=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    return { status: r.status, data: j?.data, message: j?.message ?? '' };
  };
  return { id: u.id, post: (p: string, b?: unknown) => call('POST', p, b ?? {}), patch: (p: string, b: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const made: string[] = [];

async function main() {
  const owner = await as('SUPER_ADMIN'), admin = await as('ADMIN'), sales = await as('SALES');
  const roles = await prisma.role.findMany({ where: { clientId: C }, select: { id: true, name: true } });
  const salesRole = roles.find(r => r.name === 'SALES')!.id;

  console.log('\nA. MOBILE NUMBER WHEN ADDING A TEAM MEMBER');
  let r = await owner.post('/team/members', { name: 'Edge Phone One', email: `edge-phone-1-${STAMP}@example.com`, roleId: salesRole, phone: '98480 22338' });
  if (r.data?.id) made.push(r.data.id);
  check('added with "98480 22338": stored as +919848022338', r.status === 201 && r.data?.phone === '+919848022338', r);
  const withPhone = r.data?.id;
  r = await owner.post('/team/members', { name: 'Edge Phone Bad', email: `edge-phone-bad-${STAMP}@example.com`, roleId: salesRole, phone: '12345' });
  check('a number that is not a mobile is refused in words, and nobody is added', r.status === 400 && /mobile|digit/i.test(r.message)
    && !(await prisma.user.findFirst({ where: { clientId: C, email: `edge-phone-bad-${STAMP}@example.com` } })), r);
  r = await owner.post('/team/members', { name: 'Edge Phone None', email: `edge-phone-0-${STAMP}@example.com`, roleId: salesRole });
  if (r.data?.id) made.push(r.data.id);
  check('the number is optional: added without one', r.status === 201 && !r.data?.phone, r);
  const noPhone = r.data?.id;

  console.log('\nB. SEND LOGIN ON WHATSAPP');
  r = await owner.post(`/team/members/${noPhone}/credentials/whatsapp`, { nonce: 'a' });
  check('no number on file: asks for one, by name', r.status === 400 && /Edge Phone None's mobile number/.test(r.message), r);
  r = await owner.post(`/team/members/${noPhone}/credentials/whatsapp`, { nonce: 'b', phone: '91234 56789' });
  check('a number typed there is saved on the person even when sending then fails', (await prisma.user.findUnique({ where: { id: noPhone } }))?.phone === '+919123456789', r);
  check("the shop's WhatsApp is not connected: said in words, with what to do (nothing sent)", r.status === 409 && /not connected.*Settings → WhatsApp/.test(r.message), r);
  r = await owner.post(`/team/members/${withPhone}/credentials/whatsapp`, { nonce: 'c', phone: 'abc' });
  check('a bad number typed there is refused in words', r.status === 400 && /mobile|digit/i.test(r.message), r);
  r = await admin.post(`/team/members/${owner.id}/credentials/whatsapp`, { nonce: 'd' });
  check("an Admin cannot send the owner's login anywhere", r.status === 403, r);
  r = await sales.post(`/team/members/${withPhone}/credentials/whatsapp`, { nonce: 'e' });
  check('a salesperson (no team access) cannot send anyone\'s login', r.status === 403, r.status);

  console.log('\nC. MANAGE CUSTOMER GROUPS');
  const cust = await prisma.customer.create({ data: { clientId: C, customerCode: `EGP-${STAMP % 1e6}`, name: 'Edge Perm Customer' } });
  r = await sales.post('/customer-groups/members', { group: 'Edge Perm Group', customerIds: [cust.id] });
  check('Sales may put a customer in a group (customer:update, as on the customer page)', r.status === 200 && r.data?.added === 1, r);
  r = await sales.patch(`/customer-groups/${encodeURIComponent('edge perm group')}/rules`, { noOfferMessages: true });
  check('...but not switch "no offer messages" (403)', r.status === 403, r.status);
  r = await sales.post(`/customer-groups/${encodeURIComponent('edge perm group')}/rename`, { name: 'Edge Renamed' });
  check('...nor rename it (403)', r.status === 403, r.status);
  r = await sales.del(`/customer-groups/${encodeURIComponent('edge perm group')}`);
  check('...nor delete it (403)', r.status === 403, r.status);
  r = await sales.post('/customer-groups', { name: 'Edge Sales Made' });
  check('...nor make an empty group in Settings (403)', r.status === 403, r.status);
  r = await sales.del(`/customer-groups/${encodeURIComponent('edge perm group')}/members/${cust.id}`);
  check('...and may take the customer out again', r.status === 200, r);
  await sales.post('/customer-groups/members', { group: 'Edge Perm Group', customerIds: [cust.id] });
  r = await admin.patch(`/customer-groups/${encodeURIComponent('edge perm group')}/rules`, { noOfferMessages: true });
  check('Admin may change the rules', r.status === 200 && r.data?.noOfferMessages === true, r);
  r = await admin.del(`/customer-groups/${encodeURIComponent('edge perm group')}`);
  check('Admin may delete the group', r.status === 200, r);
  await prisma.customer.delete({ where: { id: cust.id } });
  const lacking = await prisma.role.count({ where: { name: 'ADMIN', NOT: { permissions: { some: { permission: { key: 'customer:manage_groups' } } } } } });
  check("every shop's ADMIN holds customer:manage_groups", lacking === 0, lacking);
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  for (const id of made) { await prisma.userRole.deleteMany({ where: { userId: id } }); await prisma.user.delete({ where: { id } }).catch(() => {}); }
  await prisma.user.deleteMany({ where: { clientId: C, email: { startsWith: 'edge-phone-' } } }).catch(() => {});
  await prisma.customerGroup.deleteMany({ where: { clientId: C, key: { startsWith: 'edge ' } } });
  await prisma.customer.deleteMany({ where: { clientId: C, name: 'Edge Perm Customer' } });
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
