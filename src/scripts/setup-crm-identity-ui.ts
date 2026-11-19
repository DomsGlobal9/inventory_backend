/**
 * LOCAL ONLY. Makes Inventory's side of CRM's test shop "crm-identity-test" usable in the app, for the UI robot
 * PLAN-help/robot/check-crm-identity-ui.mjs: roles, shop settings (setup done), one store, an owner (tour seen),
 * and writes PLAN-help/robot/demo-crmid.json with a fresh owner token. Safe to run again.
 *
 *   DATABASE_URL/DIRECT_URL=local npx tsx src/scripts/setup-crm-identity-ui.ts
 */
import fs from 'node:fs';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';

const C = 'crm-identity-test';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}

(async () => {
  const roles = await seedRolesForClient(C);
  await prisma.clientSettings.upsert({
    where: { clientId: C },
    create: { clientId: C, businessName: 'CRM Identity Silks', timezone: 'Asia/Kolkata', setupDoneAt: new Date() } as any,
    update: { setupDoneAt: new Date() } as any
  });
  const store = await prisma.stockLocation.findFirst({ where: { clientId: C, type: 'STORE' } })
    ?? await prisma.stockLocation.create({ data: { clientId: C, code: 'MAIN', name: 'Main Store', type: 'STORE' } });
  const email = 'crm-identity-owner@example.invalid';
  let owner = await prisma.user.findFirst({ where: { clientId: C, email } });
  if (!owner) {
    // No password anyone types: the robot signs in with a token, and the account cannot be signed in to otherwise.
    owner = await prisma.user.create({ data: { clientId: C, email, name: 'Identity Owner', password: await AuthService.hashPassword(`x-${Date.now()}-${Math.random()}`), status: 'ACTIVE' as any, tourSeenAt: new Date() } as any });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
  }
  await prisma.moduleSubscription.upsert({ where: { clientId_module: { clientId: C, module: 'crm' } }, create: { clientId: C, module: 'crm', enabledBy: 'setup-crm-identity-ui' }, update: {} });
  const token = AuthService.generateToken({ userId: owner.id, clientId: C, sessionVersion: (owner as any).sessionVersion });
  const out = 'D:/villy/inventory/PLAN-help/robot/demo-crmid.json';
  fs.writeFileSync(out, JSON.stringify({ clientId: C, storeId: store.id, note: 'CRM identity UI robot (setup-crm-identity-ui.ts)', people: { owner: { name: owner.name, token } } }, null, 2));
  console.log(`ready: ${C}, store ${store.id}, owner ${owner.id}; wrote ${out}`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
