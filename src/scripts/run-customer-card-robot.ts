/**
 * Runs PLAN-help/robot/check-customer-card.mjs on the demo help-shop as its owner and a Sales person
 * (sessions never printed). Puts Lakshmi Narayanan's notes back exactly as they were afterwards.
 *
 *   npx tsx src/scripts/run-customer-card-robot.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const C = 'lakshmi-silks-demo-helpshop-1791264977589';

async function main() {
  const sign = async (role: string) => {
    const u = await prisma.user.findFirst({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true } });
    if (!u) throw new Error(`No active ${role} in ${C}`);
    return AuthService.generateToken({ userId: u.id, clientId: C, sessionVersion: u.sessionVersion });
  };
  const lakshmi = await prisma.customer.findFirstOrThrow({ where: { clientId: C, phone: '+919848022338' }, select: { id: true, notes: true } });
  try {
    const run = spawnSync('node', ['check-customer-card.mjs'], {
      cwd: path.resolve(__dirname, '../../../PLAN-help/robot'), stdio: 'inherit',
      env: { ...process.env, OWNER_TOKEN: await sign('SUPER_ADMIN'), SALES_TOKEN: await sign('SALES') }
    });
    process.exitCode = run.status ?? 1;
  } finally {
    await prisma.customer.update({ where: { id: lakshmi.id }, data: { notes: lakshmi.notes } });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
