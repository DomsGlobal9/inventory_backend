/**
 * For a hands-on UI check in the browser: writes short-lived sessions for each role of a demo
 * help-shop (and a throwaway "Look only" custom role) to a file OUTSIDE the repo, never to the
 * console. `--cleanup` removes the custom role and its person.
 *
 *   npx tsx src/scripts/ui-demo-sessions.ts <out.json>
 *   npx tsx src/scripts/ui-demo-sessions.ts --cleanup
 */
import fs from 'node:fs';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { createRole } from '../services/role-management';

const C = process.env.GROUPS_SHOP || 'lakshmi-silks-demo-helpshop-1791264977589';
const ROLE = 'Look only (UI check)';
const EMAIL = 'look-only-ui-check@example.com';

async function cleanup() {
  const u = await prisma.user.findFirst({ where: { clientId: C, email: EMAIL } });
  if (u) { await prisma.userRole.deleteMany({ where: { userId: u.id } }); await prisma.user.delete({ where: { id: u.id } }); }
  const r = await prisma.role.findFirst({ where: { clientId: C, name: ROLE } });
  if (r) { await prisma.rolePermission.deleteMany({ where: { roleId: r.id } }); await prisma.role.delete({ where: { id: r.id } }); }
}

async function main() {
  if (process.argv[2] === '--cleanup') return cleanup();
  await cleanup();
  const sign = (u: { id: string; sessionVersion: number }) => AuthService.generateToken({ userId: u.id, clientId: C, sessionVersion: u.sessionVersion });
  const out: Record<string, string> = {};
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'INVENTORY_MANAGER', 'SALES', 'WAREHOUSE']) {
    const u = await prisma.user.findFirst({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true } });
    if (u) out[role] = sign(u);
  }
  const owner = await prisma.user.findFirst({ where: { clientId: C, roles: { some: { role: { name: 'SUPER_ADMIN' } } } }, select: { id: true } });
  const role: any = await createRole({ id: owner!.id, clientId: C, permissions: ['*'], roles: ['SUPER_ADMIN'] } as any,
    { name: ROLE, permissions: ['product:view', 'supplier:view', 'purchase_order:view', 'stock_count:view', 'sales_order:view'] } as any);
  const person = await prisma.user.create({
    data: { clientId: C, name: 'Look Only Person', email: EMAIL, password: 'not-a-real-hash', status: 'ACTIVE', roles: { create: { roleId: role.id } } } as any,
    select: { id: true, sessionVersion: true }
  });
  out.CUSTOM = sign(person);
  out.CUSTOM_ROLE_ID = role.id;
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  console.log('sessions written for', Object.keys(out).filter(k => k !== 'CUSTOM_ROLE_ID').join(', '));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
