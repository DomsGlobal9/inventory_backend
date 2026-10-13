/**
 * Runs PLAN-help/robot/check-console-till.mjs against the local app: seeds one REJECTED till
 * bill for a throwaway shop id, signs a console session for an active platform admin (never
 * printed), runs the robot, and deletes the seeded bill whatever happens.
 *
 *   npx tsx src/scripts/run-console-till-robot.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const CLIENT = `till-ui-${Date.now()}`;

async function main() {
  const admin = await prisma.platformAdmin.findFirst({ where: { status: 'ACTIVE' }, select: { id: true, sessionVersion: true } });
  if (!admin) throw new Error('No active platform admin to sign in as.');
  await prisma.posInboundEvent.create({
    data: {
      clientId: CLIENT, locationId: 'test-location', kind: 'sale.completed', invoiceNo: 'INV/T/0002', payload: {},
      status: 'REJECTED', answer: 'UNKNOWN_ITEM', detail: 'Item X-1 is not in this shop', attempts: 1, settledAt: new Date()
    }
  });
  const robot = path.resolve(__dirname, '../../../PLAN-help/robot');
  const run = spawnSync('node', ['check-console-till.mjs'], {
    cwd: robot, stdio: 'inherit',
    env: { ...process.env, TEST_CLIENT: CLIENT, CONSOLE_TOKEN: AuthService.generatePlatformAdminToken({ platformAdminId: admin.id, sessionVersion: admin.sessionVersion }) }
  });
  process.exitCode = run.status ?? 1;
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await prisma.posInboundEvent.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();
  });
