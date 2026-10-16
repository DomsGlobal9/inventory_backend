/**
 * Runs PLAN-help/robot/check-silent-buttons.mjs on the demo help-shop (owner) and the Platform
 * Console (an active platform admin). Sessions are never printed; every save is answered by the robot.
 *
 *   npx tsx src/scripts/run-silent-buttons-robot.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const C = 'lakshmi-silks-demo-helpshop-1791264977589';

async function main() {
  const owner = await prisma.user.findFirstOrThrow({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: 'SUPER_ADMIN' } } } }, select: { id: true, sessionVersion: true } });
  const admin = await prisma.platformAdmin.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true, sessionVersion: true } });
  const customer = await prisma.customer.findFirstOrThrow({ where: { clientId: C, phone: '+919848022338' }, select: { id: true } });
  const offer = await prisma.offer.findFirstOrThrow({ where: { clientId: C, status: { not: 'ARCHIVED' } }, select: { id: true } });
  const run = spawnSync('node', ['check-silent-buttons.mjs'], {
    cwd: path.resolve(__dirname, '../../../PLAN-help/robot'), stdio: 'inherit',
    env: {
      ...process.env, CUSTOMER: customer.id, OFFER: offer.id,
      OWNER_TOKEN: AuthService.generateToken({ userId: owner.id, clientId: C, sessionVersion: owner.sessionVersion }),
      CONSOLE_TOKEN: AuthService.generatePlatformAdminToken({ platformAdminId: admin.id, sessionVersion: admin.sessionVersion })
    }
  });
  process.exitCode = run.status ?? 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
