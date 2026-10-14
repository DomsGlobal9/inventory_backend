/**
 * Runs PLAN-help/robot/check-customer-groups.mjs against the local app as a demo shop's owner:
 * seeds three "Robot Groups" customers, signs a fresh session (never printed), runs the robot, and
 * removes the customers and any "robot" group whatever happens.
 *
 *   npx tsx src/scripts/run-groups-robot.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const robot = path.resolve(__dirname, '../../../PLAN-help/robot');
// A demo help-shop: test data only (see project-no-real-clients-yet). Override with GROUPS_SHOP.
const C = process.env.GROUPS_SHOP || 'lakshmi-silks-demo-helpshop-1791264977589';
const stamp = Date.now() % 100000;

async function main() {
  const owner = await prisma.user.findFirst({
    where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: 'SUPER_ADMIN' } } } },
    select: { id: true, sessionVersion: true }
  });
  if (!owner) throw new Error(`No active owner in ${C}.`);
  for (const [i, n] of ['A', 'B', 'C'].entries()) {
    await prisma.customer.create({ data: { clientId: C, customerCode: `RBG-${stamp}-${n}`, name: `Robot Groups ${n}`, phone: `+9198${String(stamp).padStart(5, '0')}00${i}` } });
  }
  const run = spawnSync('node', ['check-customer-groups.mjs'], {
    cwd: robot, stdio: 'inherit',
    env: { ...process.env, OWNER_TOKEN: AuthService.generateToken({ userId: owner.id, clientId: C, sessionVersion: owner.sessionVersion }) }
  });
  process.exitCode = run.status ?? 1;
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await prisma.customer.deleteMany({ where: { clientId: C, name: { startsWith: 'Robot Groups ' } } });
    await prisma.customerGroup.deleteMany({ where: { clientId: C, key: { startsWith: 'robot' } } });
    await prisma.$disconnect();
  });
