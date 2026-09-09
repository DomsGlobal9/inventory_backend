/**
 * Creates a throwaway staff account on a restricted role, so the restricted experience can be
 * looked at in a real browser rather than reasoned about.
 *
 * Everything it makes is named with a timestamp and removed by the --cleanup pass. The password
 * is generated here and printed once; it belongs to an account that exists for a few minutes.
 *
 *   npx ts-node src/scripts/make-role-test-user.ts <clientId> [--cleanup]
 */
import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import * as roles from '../services/role-management';
import { encryptCredential } from '../lib/credentialEncryption';
import bcrypt from 'bcryptjs';

const MARK = 'qa-role-test';

async function cleanup(clientId: string) {
  const users = await prisma.user.findMany({
    where: { clientId, email: { contains: MARK } }, select: { id: true, email: true }
  });
  for (const u of users) {
    await prisma.userRole.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
    console.log(`  removed user ${u.email}`);
  }
  const testRoles = await prisma.role.findMany({
    where: { clientId, name: { startsWith: 'QA ' } }, select: { id: true, name: true }
  });
  for (const r of testRoles) {
    await prisma.rolePermission.deleteMany({ where: { roleId: r.id } });
    await prisma.userRole.deleteMany({ where: { roleId: r.id } });
    await prisma.role.delete({ where: { id: r.id } }).catch(() => {});
    console.log(`  removed role ${r.name}`);
  }
  console.log('cleanup done');
}

async function main() {
  const clientId = process.argv[2];
  if (!clientId) { console.log('Pass a clientId.'); return; }

  if (process.argv.includes('--cleanup')) {
    await cleanup(clientId);
    await prisma.$disconnect();
    return;
  }

  const owner: roles.Actor = { clientId, userId: 'qa', permissions: ['*'], roles: ['SUPER_ADMIN'] };
  const stamp = Date.now();

  // The most restricted realistic role: sells, and is not meant to see a single number about
  // what the shop paid or makes.
  const role = await roles.createRole(owner, { name: `QA shop floor ${stamp}`, template: 'shop_floor' });

  const email = `${MARK}-${stamp}@example.com`;
  const password = randomBytes(9).toString('base64url');

  const user = await prisma.user.create({
    data: {
      clientId,
      email,
      name: 'QA Shop Floor',
      password: await bcrypt.hash(password, 10),
      passwordEncrypted: encryptCredential(password),
      status: 'ACTIVE',
      roles: { create: { roleId: role.id } }
    }
  });

  const stored = await prisma.role.findUnique({
    where: { id: role.id }, include: { permissions: { include: { permission: true } } }
  });

  console.log('Created a throwaway account on a restricted role.\n');
  console.log(`  role:     ${role.name}`);
  console.log(`  holds:    ${stored?.permissions.map(p => p.permission.key).join(', ')}`);
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  userId:   ${user.id}`);
  console.log('\nRemove it again with:');
  console.log(`  npx ts-node src/scripts/make-role-test-user.ts ${clientId} --cleanup`);

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e?.message ?? e); await prisma.$disconnect(); process.exitCode = 1; });
