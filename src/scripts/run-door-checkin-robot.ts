/**
 * Runs PLAN-help/robot/check-door-checkin.mjs on the demo help-shop: two customers "scan the door QR"
 * (the same record() the WhatsApp event calls; the welcome is not sent), then an owner and a Sales
 * person work the list. Every check-in made here is deleted afterwards.
 *
 *   npx tsx src/scripts/run-door-checkin-robot.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { doorCheckins, doorCode, checkinWelcome } from '../services/door-checkin';

const C = 'lakshmi-silks-demo-helpshop-1791264977589';

async function main() {
  checkinWelcome.send = async () => null as any;
  const store = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: C, code: 'MAIN' }, select: { id: true } });
  const since = new Date();
  await doorCheckins.record(C, '919000011122', doorCode(C, store.id));                       // a new customer
  await doorCheckins.record(C, '919848022338', doorCode(C, store.id), new Date(Date.now() + 1000)); // Lakshmi, newest
  const sign = async (role: string) => {
    const u = await prisma.user.findFirst({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true, name: true } });
    if (!u) throw new Error(`No active ${role} in ${C}`);
    return { token: AuthService.generateToken({ userId: u.id, clientId: C, sessionVersion: u.sessionVersion }), name: u.name };
  };
  try {
    const owner = await sign('SUPER_ADMIN'), sales = await sign('SALES');
    const run = spawnSync('node', ['check-door-checkin.mjs'], {
      cwd: path.resolve(__dirname, '../../../PLAN-help/robot'), stdio: 'inherit',
      env: { ...process.env, OWNER_TOKEN: owner.token, OWNER_NAME: owner.name, SALES_TOKEN: sales.token }
    });
    process.exitCode = run.status ?? 1;
  } finally {
    await prisma.storeCheckin.deleteMany({ where: { clientId: C, createdAt: { gte: new Date(since.getTime() - 5000) } } });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
