/** Read-only. What each role name actually holds in the database, as opposed to in the seed. */
import { prisma } from '../lib/prisma';
import { ALL_PERMISSION_KEYS, grants } from '../config/permissions';
import { RBAC_DATA } from '../services/rbac-seed.service';

async function main() {
  for (const name of ['SUPER_ADMIN', 'ADMIN', 'GUEST', 'STAFF']) {
    const rows: any[] = await prisma.$queryRaw`
      SELECT DISTINCT p."key" FROM "roles" r
      JOIN "role_permissions" rp ON rp."role_id" = r."id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE r."name" = ${name} ORDER BY 1`;
    const keys = rows.map(r => r.key);
    console.log(name + '  (' + keys.length + ' distinct keys across all tenants)');
    console.log('  ' + keys.join(', '));

    const seeded = (RBAC_DATA.roles as any)[name]?.permissions as string[] | undefined;
    if (seeded) {
      const seedOnly = seeded.filter(k => !keys.includes(k));
      const dbOnly = keys.filter(k => !seeded.includes(k));
      if (seedOnly.length) console.log('  in seed but NOT in db: ' + seedOnly.join(', '));
      if (dbOnly.length) console.log('  in db but NOT in seed: ' + dbOnly.join(', '));
    } else {
      console.log('  (no such role in the seed -- created by some other path)');
    }
    const stale = keys.filter(k => k !== '*' && !ALL_PERMISSION_KEYS.includes(k));
    if (stale.length) console.log('  keys not in the catalogue at all: ' + stale.join(', '));
    console.log('  can it reach a money report today? ' + grants(keys, 'dashboard:view'));
    console.log('');
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e?.message ?? e); await prisma.$disconnect(); process.exitCode = 1; });
