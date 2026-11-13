/**
 * LOCAL only: prints a Platform Console session for an active platform admin, for browser robots that test the Console
 * (PLAN-help/robot/check-shop-setup.mjs). Refuses anything but the local database.
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/print-local-console-token.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

async function main() {
  for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
    if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
  }
  const admin = await prisma.platformAdmin.findFirst({ where: { status: 'ACTIVE' }, select: { id: true, sessionVersion: true } });
  if (!admin) { console.error('No active platform admin in the local database.'); process.exit(1); }
  process.stdout.write(AuthService.generatePlatformAdminToken({ platformAdminId: admin.id, sessionVersion: admin.sessionVersion }));
}
main().finally(() => prisma.$disconnect());
