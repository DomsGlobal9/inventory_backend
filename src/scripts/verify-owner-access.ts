/**
 * Does the real Akshaya, as she is stored today, get into her own dashboard?
 *
 * The unit checks in verify-permissions.ts prove the rules. This proves the rules are being
 * applied to the actual rows in the actual database, through the actual middleware -- which is
 * the gap that let an owner be told she had no permission to see her own dashboard.
 *
 * Read-only. It builds the same normalized identity auth.middleware builds, then runs it
 * through requirePermission for every route the dashboard actually calls.
 *
 *   npx ts-node src/scripts/verify-owner-access.ts [email]
 */
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/permission.middleware';

// Every permission the dashboard and its widgets sit behind, after the money split.
const DASHBOARD_CALLS: [string, string][] = [
  ['GET /reports/dashboard-summary', 'report:financial'],
  ['GET /reports/inventory-value', 'report:financial'],
  ['GET /reports/low-stock-value', 'report:financial'],
  ['GET /reports/dead-stock', 'report:financial'],
  ['GET /reports/recent-transactions', 'report:view'],
  ['GET /reports/stock-movement', 'report:view'],
  ['GET /daybook', 'report:financial'],
  ['GET /products', 'product:view'],
  ['GET /inventory', 'inventory:view'],
  ['GET /suppliers', 'supplier:view'],
  ['GET /purchase-orders', 'purchase_order:view'],
  ['GET /customers', 'customer:view'],
  ['GET /returns', 'return:view'],
  ['GET /sales-orders', 'sales_order:view'],
  ['GET /locations', 'admin:locations'],
  ['GET /team/members', 'admin:users']
];

/** Runs one identity through the real middleware and reports what the browser would get. */
function attempt(user: any, permission: string): { status: number; message?: string } {
  let outcome: { status: number; message?: string } = { status: 0 };
  const req: any = { user };
  const res: any = {
    status(code: number) { outcome.status = code; return this; },
    json(body: any) { outcome.message = body?.message; return this; }
  };
  requirePermission(permission)(req, res, () => { outcome = { status: 200 }; });
  return outcome;
}

async function main() {
  const email = process.argv[2] || 'akshayaaravapalli@gmail.com';

  const user = await prisma.user.findFirst({
    where: { email },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
  });
  if (!user) { console.log(`No user ${email}`); await prisma.$disconnect(); return; }

  // Exactly what identityCache builds and auth.middleware puts on the request.
  const roles = user.roles.map(ur => ur.role.name);
  const permissions = Array.from(new Set(
    user.roles.flatMap(ur => ur.role.permissions.map(rp => rp.permission.key))
  ));

  console.log(`${user.email}`);
  console.log(`  roles:       ${roles.join(', ') || '(none)'}`);
  console.log(`  stored keys: ${permissions.length}`);
  console.log(`  holds '*':   ${permissions.includes('*')}`);
  console.log(`  holds dashboard:view: ${permissions.includes('dashboard:view')}`);
  console.log('');

  const identity = { id: user.id, clientId: user.clientId, roles, permissions };
  let ok = 0, denied = 0;
  console.log('  What the browser gets for every call the dashboard makes:');
  for (const [label, permission] of DASHBOARD_CALLS) {
    const r = attempt(identity, permission);
    if (r.status === 200) { ok++; console.log(`    200  ${label}`); }
    else { denied++; console.log(`    ${r.status}  ${label}  -> ${r.message}`); }
  }
  console.log('');
  console.log(`  ${ok} allowed, ${denied} refused.`);

  // And the contrast: the same routes for a salesperson, which is the whole point of the split.
  const sales = await prisma.role.findFirst({
    where: { clientId: user.clientId, name: 'SALES' },
    include: { permissions: { include: { permission: true } } }
  });
  if (sales) {
    const salesPerms = sales.permissions.map(rp => rp.permission.key);
    const salesIdentity = { id: 'x', clientId: user.clientId, roles: ['SALES'], permissions: salesPerms };
    const money = DASHBOARD_CALLS.filter(([, p]) => p === 'report:financial');
    const blocked = money.filter(([, p]) => attempt(salesIdentity, p).status === 403).length;
    console.log(`  A salesperson in the same shop: ${blocked} of ${money.length} money calls refused.`);
    console.log(`    e.g. ${attempt(salesIdentity, 'report:financial').message}`);
  }

  await prisma.$disconnect();
}
main().catch(async e => { console.error(e?.message ?? e); await prisma.$disconnect(); process.exitCode = 1; });
