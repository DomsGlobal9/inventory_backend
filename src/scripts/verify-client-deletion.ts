/**
 * Verifies suspending and erasing a client.
 *
 * This is the most destructive operation in the product, so it is tested the only honest way:
 * by building a real tenant with real rows in as many tables as it touches, deleting it, and
 * then asking the DATABASE whether anything survived.
 *
 * The two properties worth this much trouble:
 *
 *   COMPLETE     nothing is left behind. Verified against information_schema rather than a
 *                list in this file, so a table added later is caught rather than assumed.
 *   CONTAINED    a neighbouring tenant is untouched. Every count for a second client is taken
 *                before and after, and compared.
 *
 * The second is the one that keeps me up: a WHERE clause dropped from one of forty statements
 * would erase the platform and pass any test that only checks the first property.
 *
 *   npx ts-node src/scripts/verify-client-deletion.ts
 */
import { prisma } from '../lib/prisma';
import { platformAdminService } from '../services/platform-admin.service';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** Counts rows for a client in every table the database says has a client_id. */
async function footprint(clientId: string) {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'client_id'
    ORDER BY table_name
  `;
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "${table_name}" WHERE client_id = $1`, clientId
    );
    const n = Number(rows[0]?.count ?? 0);
    if (n > 0) counts[table_name] = n;
  }
  return counts;
}

/** Builds a tenant with something in as many tables as possible. */
async function buildTenant(clientId: string) {
  await seedRolesForClient(clientId);
  const role = await prisma.role.findFirst({ where: { clientId, name: 'SUPER_ADMIN' } });

  const user = await prisma.user.create({
    data: {
      clientId, name: 'Doomed Owner', email: `owner@${clientId}.test`,
      password: await AuthService.hashPassword('doesnt-matter-1234'), status: 'ACTIVE'
    }
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role!.id } });

  const location = await prisma.stockLocation.create({
    data: { clientId, name: 'Doomed Store', code: `DOOM-${Date.now()}`, type: 'STORE' }
  });

  const product = await prisma.product.create({
    data: {
      clientId, slug: `doomed-${Date.now()}`, productCode: `DOOM-${Date.now()}`,
      title: 'Doomed Saree', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE'
    }
  });

  const variant = await prisma.productVariant.create({
    data: {
      clientId, productId: product.id, sku: `DOOM-${Date.now()}-RED`,
      variantCode: `DV-${Date.now()}`, colorName: 'Red', size: 'M'
    }
  });

  await prisma.inventoryStock.create({
    data: { clientId, variantId: variant.id, locationId: location.id, quantity: 5, reservedQty: 0 }
  });
  await prisma.variantLocationProfile.create({
    data: { variantId: variant.id, locationId: location.id, isAvailable: true, priceOverride: null }
  });
  await prisma.supplier.create({ data: { clientId, name: 'Doomed Supplier', supplierCode: `DS-${Date.now()}` } });
  await prisma.auditLog.create({
    data: { clientId, userId: user.id, action: 'CREATE', entityType: 'Product', entityId: product.id }
  });

  return { userId: user.id, productId: product.id, variantId: variant.id, locationId: location.id };
}

async function main() {
  const doomed = `doomed-tenant-${Date.now()}`;
  const neighbour = `neighbour-tenant-${Date.now()}`;

  console.log('\nBUILDING TWO TENANTS');
  await buildTenant(doomed);
  await buildTenant(neighbour);

  const doomedBefore = await footprint(doomed);
  const neighbourBefore = await footprint(neighbour);
  check('the doomed tenant has rows in several tables',
    Object.keys(doomedBefore).length >= 6, Object.keys(doomedBefore).join(', '));
  check('so does the neighbour', Object.keys(neighbourBefore).length >= 6);

  // ─── SUSPEND ──────────────────────────────────────────────────────────────
  console.log('\nSUSPENDING IS REVERSIBLE AND DESTROYS NOTHING');
  const suspend = await platformAdminService.setClientSuspended(doomed, true);
  check('it deactivates the users', suspend.usersAffected >= 1, `${suspend.usersAffected}`);
  check('the client reads as suspended', await platformAdminService.isClientSuspended(doomed));

  const afterSuspend = await footprint(doomed);
  check('nothing was deleted by suspending',
    JSON.stringify(afterSuspend) === JSON.stringify(doomedBefore));

  await platformAdminService.setClientSuspended(doomed, false);
  check('and it can be reinstated', !(await platformAdminService.isClientSuspended(doomed)));

  // ─── THE CONFIRMATION ─────────────────────────────────────────────────────
  console.log('\nDELETION CANNOT HAPPEN BY ACCIDENT');
  const preview = await platformAdminService.previewClientDeletion(doomed);
  check('a preview says what would be destroyed', preview.products >= 1 && preview.users >= 1,
    `${preview.products} products, ${preview.users} users`);

  for (const wrong of ['', 'yes', doomed.toUpperCase(), doomed + ' ', neighbour]) {
    let refused = false;
    try { await platformAdminService.deleteClientCompletely(doomed, wrong); }
    catch { refused = true; }
    if (!refused) { check(`the wrong confirmation ${JSON.stringify(wrong)} is refused`, false); break; }
  }
  check('every wrong confirmation is refused', true);
  check('and nothing was deleted while refusing',
    JSON.stringify(await footprint(doomed)) === JSON.stringify(doomedBefore));

  // ─── THE DELETE ───────────────────────────────────────────────────────────
  console.log('\nDELETING ERASES EVERYTHING, AND ONLY THIS TENANT');
  const result = await platformAdminService.deleteClientCompletely(doomed, doomed);
  check('it reports success', result.deleted === true);

  const doomedAfter = await footprint(doomed);
  check('not one row survives anywhere',
    Object.keys(doomedAfter).length === 0, JSON.stringify(doomedAfter));

  // The property a completeness test alone would never catch.
  const neighbourAfter = await footprint(neighbour);
  check('the neighbouring tenant is untouched',
    JSON.stringify(neighbourAfter) === JSON.stringify(neighbourBefore),
    `before ${JSON.stringify(neighbourBefore)} after ${JSON.stringify(neighbourAfter)}`);

  const orphanUsers = await prisma.user.count({ where: { clientId: doomed } });
  const orphanProducts = await prisma.product.count({ where: { clientId: doomed } });
  const orphanRoles = await prisma.role.count({ where: { clientId: doomed } });
  check('no users, products or roles remain',
    orphanUsers === 0 && orphanProducts === 0 && orphanRoles === 0,
    `${orphanUsers}/${orphanProducts}/${orphanRoles}`);

  console.log('\nDELETING AGAIN IS REFUSED RATHER THAN SILENTLY SUCCEEDING');
  let secondRefused = false;
  try { await platformAdminService.deleteClientCompletely(doomed, doomed); }
  catch { secondRefused = true; }
  check('a client that no longer exists cannot be deleted again', secondRefused);

  // ─── CLEAN UP THE NEIGHBOUR ───────────────────────────────────────────────
  await platformAdminService.deleteClientCompletely(neighbour, neighbour);
  const neighbourGone = await footprint(neighbour);
  check('the neighbour deletes cleanly too, so the first was not a fluke',
    Object.keys(neighbourGone).length === 0, JSON.stringify(neighbourGone));

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const name of failures) console.log(`  - ${name}`);
  }
}

main()
  .catch(error => { console.error('\nSuite crashed:', error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
