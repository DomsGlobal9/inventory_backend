/**
 * Read-only. What the split-money migration would do to real people, before it runs.
 *
 * A migration that removes access is not reviewable by reading its SQL. The SQL is short; the
 * consequence is "some number of staff stop seeing the shop's profit tomorrow morning". This
 * prints that number, and checks the one assumption the migration rests on -- that the role
 * names in the database are the names its mapping knows about.
 *
 *   npx ts-node src/scripts/permission-impact.ts
 */
import { prisma } from '../lib/prisma';

const KNOWN_MONEY = new Set(['ADMIN', 'INVENTORY_MANAGER', 'SUPER_ADMIN']);
const SEEDED = new Set(['ADMIN', 'INVENTORY_MANAGER', 'SUPER_ADMIN', 'SALES', 'WAREHOUSE']);
const pad = (v: any, n: number) => String(v).padEnd(n);
const rpad = (v: any, n: number) => String(v).padStart(n);

async function main() {
  const rows: any[] = await prisma.$queryRaw`
    SELECT r."name" AS role,
           COUNT(DISTINCT r."id")::int AS roles,
           COUNT(DISTINCT ur."user_id")::int AS users
    FROM "roles" r
    JOIN "role_permissions" rp ON rp."role_id" = r."id"
    JOIN "permissions" p ON p."id" = rp."permission_id" AND p."key" = 'dashboard:view'
    LEFT JOIN "user_roles" ur ON ur."role_id" = r."id"
    GROUP BY r."name"
    ORDER BY 3 DESC, 1`;

  console.log("WHO CAN READ THE SHOP'S MONEY TODAY, THROUGH dashboard:view");
  console.log('  role                 roles  people');
  let keeps = 0, loses = 0;
  for (const r of rows) {
    const verdict = KNOWN_MONEY.has(r.role) ? 'keeps it' : 'LOSES money access';
    console.log('  ' + pad(r.role, 20) + rpad(r.roles, 5) + rpad(r.users, 8) + '   ' + verdict);
    if (KNOWN_MONEY.has(r.role)) keeps += r.users; else loses += r.users;
  }
  console.log('');
  console.log('  ' + loses + " people stop being able to read costs, profit and supplier spend.");
  console.log('  ' + keeps + ' keep it.');

  // The migration names roles once, to decide the mapping. That is only safe if the names in
  // the database are the ones it knows. A shop that renamed its roles, or a tenant seeded by
  // some older path, would be invisible to it.
  const allRoles: any[] = await prisma.$queryRaw`
    SELECT r."name",
           COUNT(DISTINCT r."id")::int AS copies,
           COUNT(DISTINCT ur."user_id")::int AS people,
           COUNT(DISTINCT p."key")::int AS perms,
           BOOL_OR(p."key" = '*') AS wildcard,
           BOOL_OR(p."key" = 'dashboard:view') AS dash
    FROM "roles" r
    LEFT JOIN "user_roles" ur ON ur."role_id" = r."id"
    LEFT JOIN "role_permissions" rp ON rp."role_id" = r."id"
    LEFT JOIN "permissions" p ON p."id" = rp."permission_id"
    GROUP BY r."name" ORDER BY 3 DESC, 1`;

  console.log('');
  console.log('EVERY ROLE NAME IN THE DATABASE');
  console.log('  name                 copies  people  perms  wildcard  dashboard');
  const unknown: string[] = [];
  for (const r of allRoles) {
    if (!SEEDED.has(r.name)) unknown.push(r.name + ' (' + r.people + ' people)');
    console.log('  ' + pad(r.name, 20) + rpad(r.copies, 6) + rpad(r.people, 8) + rpad(r.perms, 7)
      + rpad(r.wildcard, 10) + rpad(r.dash, 11));
  }
  console.log('');
  console.log(unknown.length
    ? '  !! Roles the migration mapping does not know: ' + unknown.join(', ')
    : '  Every role name is one the migration knows about.');

  const totals: any[] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS users,
           COUNT(*) FILTER (WHERE u."status" = 'ACTIVE')::int AS active,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "user_roles" ur WHERE ur."user_id" = u."id"))::int AS with_role
    FROM "users" u`;
  const t = totals[0];
  console.log('');
  console.log('  Users: ' + t.users + ' total, ' + t.active + ' active, ' + t.with_role + ' holding any role.');

  const already: any[] = await prisma.$queryRaw`
    SELECT "key" FROM "permissions"
    WHERE "key" IN ('cost:view','cost:manage','report:view','report:financial','tryon:generate','team:view_password','dispatch:view')
    ORDER BY 1`;
  console.log('  Keys already present (the migration is idempotent): '
    + (already.map(r => r.key).join(', ') || 'none'));

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e?.message ?? e); await prisma.$disconnect(); process.exitCode = 1; });
