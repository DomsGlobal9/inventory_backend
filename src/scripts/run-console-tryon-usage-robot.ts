/**
 * Runs PLAN-help/robot/check-console-tryon-usage-split.mjs: the catalog / colour split and the
 * money line, in the Platform Console and on the shop's own Settings screen, at 1280 and 390.
 *
 * LOCAL DATABASE ONLY. Seeds three throwaway shops (one user each, never signed in with a
 * password) on the shared key / an own key with billing on / an own key with billing off, a local
 * Gateway stub on 4099, and adds a known amount to verify-suites-tenant's month for the Settings
 * screen -- all put back afterwards. Sessions are token cookies; no password is touched.
 * Needs the local server on 4016 started with CATALOG_TRYON_GATEWAY_URL=http://localhost:4099.
 *
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory npx tsx src/scripts/run-console-tryon-usage-robot.ts
 */
if (!/localhost:55433/.test(process.env.DATABASE_URL ?? '') || !/localhost:55433/.test(process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '')) {
  console.error('Refusing: DATABASE_URL/DIRECT_URL must be the local copy (localhost:55433).');
  process.exit(2);
}
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { tryOnUsageService } from '../services/tryon';
import { startGatewayUsageStub } from './gateway-usage-stub';

const STAMP = Date.now();
const API = 'http://localhost:4016/api/v1';
const SHOP = 'verify-suites-tenant';
const shops = { shared: `colour-ui-shared-${STAMP}`, on: `colour-ui-on-${STAMP}`, off: `colour-ui-off-${STAMP}` };

async function main() {
  const stub = await startGatewayUsageStub(4099);
  const admin = await prisma.platformAdmin.findFirst({ where: { status: 'ACTIVE' }, select: { id: true, sessionVersion: true } });
  if (!admin) throw new Error('No active platform admin in the local DB.');
  const consoleToken = AuthService.generatePlatformAdminToken({ platformAdminId: admin.id, sessionVersion: admin.sessionVersion });

  // What the shop's own row looked like, so it can be put back exactly.
  const day = (await tryOnUsageService.summary(SHOP)).month;
  const shopRowsBefore = await prisma.tryOnUsage.findMany({ where: { clientId: SHOP, service: 'CATALOG_TRYON', day: { startsWith: day } } });

  try {
    for (const [tag, c] of Object.entries(shops)) {
      await prisma.user.create({
        data: { clientId: c, name: `Colour UI ${tag}`, email: `${c}@example.invalid`, password: crypto.randomBytes(24).toString('hex') } as any
      });
    }
    const rec = async (c: string, n: number, o: any) => { for (let i = 0; i < n; i++) await tryOnUsageService.record(c, o); };
    await rec(shops.shared, 3, { started: true, completed: true, viewsGenerated: 4 });
    await rec(shops.shared, 2, { started: true, completed: true, viewsGenerated: 4, colour: true });
    await rec(shops.shared, 1, { started: true, failed: true, colour: true });
    await rec(shops.shared, 1, { started: true, cancelled: true });
    await rec(shops.on, 3, { started: true, completed: true, viewsGenerated: 4 });
    await rec(shops.on, 2, { started: true, completed: true, viewsGenerated: 4, colour: true });
    await tryOnUsageService.setMonthlyLimit(shops.on, 10, 'robot@example.invalid');
    await rec(shops.off, 1, { started: true, completed: true, viewsGenerated: 4 });

    const addKey = async (c: string, key: string) => {
      const r = await fetch(`${API}/admin/clients/${c}/service-keys`, {
        method: 'POST', headers: { cookie: `platform_admin_token=${consoleToken}`, 'content-type': 'application/json', origin: 'http://localhost:5183' },
        body: JSON.stringify({ service: 'CATALOG_TRYON', key })
      });
      if (r.status !== 200) throw new Error(`could not save the key for ${c}: ${r.status}`);
    };
    await addKey(shops.on, `sek_test_on_${STAMP}`);
    await addKey(shops.off, `sek_test_off_${STAMP}`);

    const before = await tryOnUsageService.summary(SHOP);
    await rec(SHOP, 2, { started: true, completed: true, viewsGenerated: 4 });
    await rec(SHOP, 1, { started: true, completed: true, viewsGenerated: 4, colour: true });
    await rec(SHOP, 1, { started: true, failed: true });
    const expected = { catalogs: before.catalogs + 2, colours: before.colourVariants + 1, notCharged: before.notCharged + 1 };

    const owner = await prisma.user.findFirst({ where: { clientId: SHOP, email: 'verify-suites@example.com' }, select: { id: true, sessionVersion: true } });
    if (!owner) throw new Error('No verify-suites owner locally.');
    // spawn, not spawnSync: the Gateway stub lives in THIS process and must keep answering
    // while the robot runs (spawnSync froze it, and every money line timed out to the sentence).
    const run = spawn('node', ['check-console-tryon-usage-split.mjs'], {
      cwd: path.resolve(__dirname, '../../../PLAN-help/robot'), stdio: 'inherit',
      env: {
        ...process.env, APP_URL: 'http://localhost:5183',
        CONSOLE_TOKEN: consoleToken,
        OWNER_TOKEN: AuthService.generateToken({ userId: owner.id, clientId: SHOP, sessionVersion: owner.sessionVersion }),
        SHOP_SHARED: shops.shared, SHOP_ON: shops.on, SHOP_OFF: shops.off,
        EXPECT_SHOP: JSON.stringify(expected),
        SHOTS: 'D:/downloads/tryon-usage-split'
      }
    });
    process.exitCode = await new Promise<number>(resolve => run.on('exit', code => resolve(code ?? 1)));
  } finally {
    const ids = Object.values(shops);
    await prisma.tryOnUsage.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.clientServiceCredential.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.clientServiceLimit.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.user.deleteMany({ where: { clientId: { in: ids } } });
    // The shop's month back exactly as it was.
    await prisma.tryOnUsage.deleteMany({ where: { clientId: SHOP, service: 'CATALOG_TRYON', day: { startsWith: day } } });
    for (const r of shopRowsBefore) await prisma.tryOnUsage.create({ data: r });
    await stub.close();
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
