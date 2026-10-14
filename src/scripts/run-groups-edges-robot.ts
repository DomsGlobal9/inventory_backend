/**
 * Runs PLAN-help/robot/check-customer-groups-edges.mjs as a demo help-shop's owner and warehouse
 * person: seeds "Robot Edge" customers (one already in 20 groups), a group "Robot Other", and an
 * active offer only for "Robot Offer Group". Removes all of it whatever happens.
 *
 *   npx tsx src/scripts/run-groups-edges-robot.ts
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const robot = path.resolve(__dirname, '../../../PLAN-help/robot');
const C = process.env.GROUPS_SHOP || 'lakshmi-silks-demo-helpshop-1791264977589';
const stamp = Date.now() % 100000;

async function token(role: string) {
  const u = await prisma.user.findFirst({ where: { clientId: C, status: 'ACTIVE', roles: { some: { role: { name: role } } } }, select: { id: true, sessionVersion: true } });
  if (!u) throw new Error(`No active ${role} in ${C}.`);
  return AuthService.generateToken({ userId: u.id, clientId: C, sessionVersion: u.sessionVersion });
}

async function main() {
  const mk = (n: string, i: number, tags: string[] = []) => prisma.customer.create({
    data: { clientId: C, customerCode: `RBE-${stamp}-${i}`, name: `Robot Edge ${n}`, phone: `+9197${String(stamp).padStart(5, '0')}0${i}`, tags }
  });
  await mk('A', 1);
  await mk('B', 2);
  await mk('Full', 3, Array.from({ length: 20 }, (_, i) => `Robot Filler ${i}`));
  await mk('Offer member', 4, ['Robot Offer Group']);
  await prisma.customerGroup.create({ data: { clientId: C, name: 'Robot Other', key: 'robot other' } });
  await prisma.offer.create({ data: { clientId: C, offerCode: `RBE-${stamp}`, name: 'Robot edge offer', valueType: 'PERCENTAGE', value: 5, startsAt: new Date(), status: 'ACTIVE', customerTags: ['Robot Offer Group'] } as any });
  const run = spawnSync('node', ['check-customer-groups-edges.mjs'], {
    cwd: robot, stdio: 'inherit',
    env: { ...process.env, OWNER_TOKEN: await token('SUPER_ADMIN'), WAREHOUSE_TOKEN: await token('WAREHOUSE') }
  });
  process.exitCode = run.status ?? 1;
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await prisma.offer.deleteMany({ where: { clientId: C, name: 'Robot edge offer' } });
    await prisma.customer.deleteMany({ where: { clientId: C, name: { startsWith: 'Robot Edge ' } } });
    await prisma.customerGroup.deleteMany({ where: { clientId: C, key: { startsWith: 'robot' } } });
    await prisma.$disconnect();
  });
