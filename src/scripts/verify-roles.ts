/**
 * Do roles actually restrict people?
 *
 * verify-permissions.ts proves the rules are consistent. This proves they are enforced: it
 * composes roles through the real service, against a real tenant, and then asks the real
 * middleware what a person holding each one can reach.
 *
 * The scenarios are the ones a shop actually has -- somebody on the shop floor, somebody in the
 * stock room, a buyer, a manager -- and the questions are the ones a shopkeeper would ask:
 * can the person on the till see what I paid? Can my manager give themselves a pay-grade they
 * do not have? What happens if I delete a role people are using?
 *
 * Every role it creates is deleted again at the end, including on failure.
 *
 *   npx ts-node src/scripts/verify-roles.ts
 */
import { prisma } from '../lib/prisma';
import * as roles from '../services/role-management';
import { requirePermission } from '../middleware/permission.middleware';
import { expandPermissions } from '../config/permissions';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** Runs an identity through the real middleware, exactly as a request would. */
function reaches(permissions: string[], required: string, roleNames: string[] = []): boolean {
  let allowed = false;
  const req: any = { user: { id: 'test', clientId: 'test', permissions, roles: roleNames } };
  const res: any = { status() { return this; }, json() { return this; } };
  requirePermission(required)(req, res, () => { allowed = true; });
  return allowed;
}

/** What a person holding this role could actually do, as the server would decide it. */
async function effective(roleId: string): Promise<string[]> {
  const row = await prisma.role.findUnique({
    where: { id: roleId },
    include: { permissions: { include: { permission: true } } }
  });
  return Array.from(expandPermissions((row?.permissions ?? []).map(rp => rp.permission.key)));
}

async function main() {
  // A tenant to work in. Never Akshaya's -- this creates and deletes roles.
  // clientId is the tenant slug -- there is no Client table here; tenants live in the gateway.
  // A throwaway one, never a live shop: this creates roles, assigns somebody to one to prove
  // the delete guard, and removes all of it again.
  const candidates = await prisma.user.findMany({
    distinct: ['clientId'], select: { clientId: true }, orderBy: { clientId: 'asc' }
  });
  const clientId = candidates.map(c => c.clientId).find(id => /^(demo|doomed|e2e|test)/i.test(id));
  if (!clientId) { console.log('No throwaway tenant to test in.'); await prisma.$disconnect(); return; }
  const client = { id: clientId, name: clientId };
  console.log(`Working in tenant: ${client.name}\n`);

  const owner: roles.Actor = {
    clientId: client.id, userId: 'owner-test', permissions: ['*'], roles: ['SUPER_ADMIN']
  };
  const created: string[] = [];

  try {
    // ── The owner composes the roles a shop actually has ────────────────────
    console.log('AN OWNER CAN COMPOSE THE ROLES A SHOP ACTUALLY HAS');
    const catalogue = roles.getCatalogue(owner);
    check('the roles screen has something to draw',
      catalogue.groups.length === 6 && catalogue.templates.length >= 5);
    check('every permission is grantable by the owner',
      catalogue.groups.every(g => g.permissions.every(p => p.grantable)));
    check('and the money ones are flagged as sensitive',
      catalogue.groups.find(g => g.group === 'Money')!.permissions.some(p => p.sensitive));

    const till = await roles.createRole(owner, { name: 'Till ' + Date.now(), template: 'shop_floor' });
    created.push(till.id);
    const stockRoom = await roles.createRole(owner, { name: 'Stock room ' + Date.now(), template: 'stock_room' });
    created.push(stockRoom.id);
    const buyer = await roles.createRole(owner, { name: 'Buyer ' + Date.now(), template: 'buyer' });
    created.push(buyer.id);
    check('three roles created from starting points', created.length === 3);

    // ── The person on the till ──────────────────────────────────────────────
    console.log('\nTHE PERSON ON THE TILL IS ACTUALLY RESTRICTED');
    const tillPerms = await effective(till.id);
    check('they can take an order', reaches(tillPerms, 'sales_order:create'));
    check('and look up a product', reaches(tillPerms, 'product:view'));
    check('and see the dashboard', reaches(tillPerms, 'dashboard:view'));
    // The whole point. These are refused by the server, not hidden by the browser.
    check('but the server refuses them the money reports', !reaches(tillPerms, 'report:financial'));
    check('and refuses them what the shop paid', !reaches(tillPerms, 'cost:view'));
    check('and refuses them the day book', !reaches(tillPerms, 'report:financial'));
    check('and refuses them supplier prices', !reaches(tillPerms, 'supplier:view'));
    check('and refuses them purchase orders', !reaches(tillPerms, 'purchase_order:view'));
    check('and refuses them the team', !reaches(tillPerms, 'admin:users'));
    check('and refuses them stock corrections', !reaches(tillPerms, 'inventory:adjust'));

    // ── The stock room ──────────────────────────────────────────────────────
    console.log('\nTHE STOCK ROOM MOVES STOCK WITHOUT SEEING MONEY');
    const stockPerms = await effective(stockRoom.id);
    check('they can receive stock', reaches(stockPerms, 'inventory:receive'));
    check('and finish a count', reaches(stockPerms, 'stock_count:complete'));
    check('and see operational reports', reaches(stockPerms, 'report:view'));
    check('but not the money reports', !reaches(stockPerms, 'report:financial'));
    check('and cannot restate what stock cost', !reaches(stockPerms, 'cost:manage'));
    check('and cannot change a selling price', !reaches(stockPerms, 'product:update'));

    // ── The buyer ───────────────────────────────────────────────────────────
    console.log('\nTHE BUYER SEES MONEY, BECAUSE THAT IS THE JOB');
    const buyerPerms = await effective(buyer.id);
    check('they see what things cost', reaches(buyerPerms, 'cost:view'));
    check('and the money reports', reaches(buyerPerms, 'report:financial'));
    check('and can restate a cost that was wrong', reaches(buyerPerms, 'cost:manage'));
    check('but still cannot manage the team', !reaches(buyerPerms, 'admin:users'));
    check('nor read a colleague\'s password', !reaches(buyerPerms, 'team:view_password'));
    // Implication, working through the database rather than only in a unit test.
    check('cost:view was never stored, and is conferred anyway',
      buyerPerms.includes('cost:view') && buyerPerms.includes('report:view'));

    // ── Nobody can hand out what they do not hold ───────────────────────────
    console.log('\nNOBODY CAN GIVE AWAY WHAT THEY DO NOT HAVE');
    // The escalation this screen would otherwise be: a manager who can edit roles composes one
    // with cost:manage, assigns it to themselves, and now holds it.
    const manager: roles.Actor = {
      clientId: client.id, userId: 'mgr-test', roles: ['MANAGER'],
      permissions: ['admin:users', 'sales_order:view', 'product:view', 'dashboard:view']
    };
    let refused = '';
    try {
      const bad = await roles.createRole(manager, { name: 'Escalation ' + Date.now(), permissions: ['cost:manage'] });
      created.push(bad.id);
    } catch (e: any) { refused = e.message; }
    check('a manager cannot mint a role with cost they do not hold', !!refused, refused);
    check('and the refusal names the thing in plain language',
      refused.includes('Set and restate what stock cost'), refused);

    let wildcardRefused = '';
    try {
      const bad = await roles.createRole(owner, { name: 'God ' + Date.now(), permissions: ['*'] });
      created.push(bad.id);
    } catch (e: any) { wildcardRefused = e.message; }
    check('not even the owner can grant total access from this screen', !!wildcardRefused, wildcardRefused);

    let unknownRefused = '';
    try {
      const bad = await roles.createRole(owner, { name: 'Invented ' + Date.now(), permissions: ['money:steal'] });
      created.push(bad.id);
    } catch (e: any) { unknownRefused = e.message; }
    check('a shop cannot invent a permission', !!unknownRefused, unknownRefused);

    // What the manager CAN do, so the rule is a boundary and not a wall.
    const ok = await roles.createRole(manager, {
      name: 'Junior ' + Date.now(), permissions: ['sales_order:view', 'product:view']
    });
    created.push(ok.id);
    check('but they can compose a role up to their own authority', !!ok.id);

    // ── The owner role is the way back in ───────────────────────────────────
    console.log('\nTHE OWNER ROLE CANNOT BE EDITED AWAY');
    const all = await roles.listRoles(owner);
    const ownerRole = all.find(r => r.isOwner);
    check('the owner role is marked and locked', !!ownerRole && !ownerRole.editable);
    if (ownerRole) {
      let editRefused = '';
      try { await roles.updateRole(owner, ownerRole.id, { permissions: [] }); }
      catch (e: any) { editRefused = e.message; }
      check('editing it is refused', !!editRefused, editRefused);

      let delRefused = '';
      try { await roles.deleteRole(owner, ownerRole.id); }
      catch (e: any) { delRefused = e.message; }
      check('deleting it is refused', !!delRefused, delRefused);
    }
    let reservedRefused = '';
    try {
      const bad = await roles.createRole(owner, { name: 'SUPER_ADMIN', permissions: [] });
      created.push(bad.id);
    } catch (e: any) { reservedRefused = e.message; }
    check('and the name cannot be taken by a new role', !!reservedRefused, reservedRefused);

    // ── Changing a role tells you who it affects ────────────────────────────
    console.log('\nCHANGING A ROLE TELLS YOU WHO IT AFFECTS, BEFORE YOU DO IT');
    const impact = await roles.roleImpact(owner, buyer.id, ['sales_order:view']);
    check('it names what the change takes away',
      impact.losing.some(l => l.key === 'cost:view') && impact.losing.some(l => l.key === 'report:financial'),
      impact.losing.map(l => l.key).join(', '));
    check('in words a shopkeeper reads, not keys',
      impact.losing.some(l => l.label.includes('what the business paid')));
    check('and counts the people', typeof impact.memberCount === 'number');

    // ── Deleting a role people are using ────────────────────────────────────
    console.log('\nA ROLE PEOPLE ARE USING CANNOT BE DELETED OUT FROM UNDER THEM');
    const someone = await prisma.user.findFirst({ where: { clientId: client.id }, select: { id: true } });
    if (someone) {
      await prisma.userRole.create({ data: { userId: someone.id, roleId: till.id } });
      let inUse: any = null;
      try { await roles.deleteRole(owner, till.id); } catch (e: any) { inUse = e; }
      check('deleting it is refused with 409', inUse?.statusCode === 409, String(inUse?.statusCode));
      check('and the message says what to do first',
        /Move them to another role first/.test(inUse?.message || ''), inUse?.message);
      check('the screen can tell this apart from other failures', inUse?.code === 'ROLE_IN_USE');
      await prisma.userRole.delete({ where: { userId_roleId: { userId: someone.id, roleId: till.id } } });
    }

    // ── One tenant cannot touch another's roles ─────────────────────────────
    console.log('\nONE SHOP CANNOT SEE OR TOUCH ANOTHER SHOP\'S ROLES');
    const stranger: roles.Actor = {
      clientId: 'some-other-client-id', userId: 'x', permissions: ['*'], roles: ['SUPER_ADMIN']
    };
    let crossTenant: any = null;
    try { await roles.updateRole(stranger, till.id, { name: 'Hijacked' }); }
    catch (e: any) { crossTenant = e; }
    check('editing another tenant\'s role is a 404, not a 403', crossTenant?.statusCode === 404,
      String(crossTenant?.statusCode));
    // 404 on purpose: a 403 would confirm the role exists.
    check('and it does not confirm the role exists', /No such role/.test(crossTenant?.message || ''));

  } finally {
    for (const id of created) {
      await prisma.rolePermission.deleteMany({ where: { roleId: id } }).catch(() => {});
      await prisma.userRole.deleteMany({ where: { roleId: id } }).catch(() => {});
      await prisma.role.delete({ where: { id } }).catch(() => {});
    }
    console.log(`\n  (cleaned up ${created.length} test roles)`);
  }

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  await prisma.$disconnect();
}

main().catch(async e => { console.error('\nSuite did not finish:', e?.message ?? e); await prisma.$disconnect(); process.exitCode = 1; });
