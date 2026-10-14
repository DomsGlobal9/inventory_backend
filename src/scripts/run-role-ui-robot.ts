/**
 * Runs PLAN-help/robot/check-role-ui.mjs on a demo help-shop: every built-in role, plus a custom
 * "look only" role made for the run (and changed mid-session by the owner), each signed in with a
 * fresh session that is never printed. Removes the custom role and its person afterwards.
 *
 *   npx tsx src/scripts/run-role-ui-robot.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { createRole } from '../services/role-management';

const C = process.env.GROUPS_SHOP || 'lakshmi-silks-demo-helpshop-1791264977589';
const STAMP = Date.now();
// A shop's own role: may look at products, suppliers, orders and stock -- change nothing, no Dashboard.
const CUSTOM_PERMS = ['product:view', 'supplier:view', 'purchase_order:view', 'stock_count:view', 'sales_order:view'];

async function main() {
  const sign = (u: { id: string; sessionVersion: number }) => AuthService.generateToken({ userId: u.id, clientId: C, sessionVersion: u.sessionVersion });
  const tokens: Record<string, string> = {};
  let ownerToken = '';
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'INVENTORY_MANAGER', 'SALES', 'WAREHOUSE']) {
    const u = await prisma.user.findFirst({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true } });
    if (!u) continue;
    if (role === 'SUPER_ADMIN') ownerToken = sign(u); else tokens[role] = sign(u);
  }
  const owner = await prisma.user.findFirst({ where: { clientId: C, roles: { some: { role: { name: 'SUPER_ADMIN' } } } }, select: { id: true } });
  const role = await createRole({ id: owner!.id, clientId: C, permissions: ['*'], roles: ['SUPER_ADMIN'] } as any, { name: `Look only ${STAMP % 100000}`, permissions: CUSTOM_PERMS } as any);
  const person = await prisma.user.create({
    data: { clientId: C, name: 'Look Only Person', email: `look-only-${STAMP}@example.com`, password: 'not-a-real-hash', status: 'ACTIVE', roles: { create: { roleId: (role as any).id } } } as any,
    select: { id: true, sessionVersion: true }
  });
  tokens.CUSTOM = sign(person);

  const [product, supplier, po, audit] = await Promise.all([
    prisma.product.findFirst({ where: { clientId: C, trashedAt: null }, select: { id: true } }),
    prisma.supplier.findFirst({ where: { clientId: C }, select: { id: true } }),
    prisma.purchaseOrder.findFirst({ where: { clientId: C }, select: { id: true } }),
    prisma.stockCount.findFirst({ where: { clientId: C }, select: { id: true } }).catch(() => null)
  ]);
  try {
    const run = spawnSync('node', ['check-role-ui.mjs'], {
      cwd: path.resolve(__dirname, '../../../PLAN-help/robot'), stdio: 'inherit',
      env: {
        ...process.env, TOKENS: JSON.stringify(tokens), OWNER_TOKEN: ownerToken, CUSTOM_ROLE_ID: (role as any).id,
        CUSTOM_PERMS: JSON.stringify(CUSTOM_PERMS),
        IDS: JSON.stringify({ product: product?.id, supplier: supplier?.id, po: po?.id, audit: audit?.id })
      }
    });
    process.exitCode = run.status ?? 1;
  } finally {
    await prisma.userRole.deleteMany({ where: { userId: person.id } });
    await prisma.user.delete({ where: { id: person.id } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { roleId: (role as any).id } });
    await prisma.role.delete({ where: { id: (role as any).id } }).catch(() => {});
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
