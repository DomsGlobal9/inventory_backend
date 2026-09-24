/**
 * The long-lived `demo-client` tenant that thirteen suites are written against.
 *
 * WHY THIS EXISTS. Those suites do not make their own tenant -- they expect this one to be there,
 * sign in as its admin, and build their fixtures on it. When it went, they stopped at their first
 * line with "No demo-client admin found" or a bare Prisma NotFoundError. This is the second time
 * that has happened to this codebase: scripts/support/testTenant.ts was written after the SAME
 * thing befell `verify-suites-tenant`, and its opening note says so.
 *
 * So, the same answer as before: recreate it on demand rather than hope nobody deletes it. Running
 * this is safe at any time -- it adds what is missing and touches nothing that is already there.
 *
 * It is a DEMO tenant, deliberately: ordinary-looking stock a suite can sort, price and sell, with
 * no pretence of being a real shop's books.
 */
import { prisma } from '../../lib/prisma';
import { AuthService } from '../../services/auth.service';
import { seedRolesForClient } from '../../services/rbac-seed.service';
import { seedCatalogDefaultsForClient } from '../../services/catalog-seed.service';

export const DEMO_CLIENT = 'demo-client';
export const DEMO_EMAIL = 'admin@example.com';

export async function ensureDemoClient(): Promise<{ clientId: string; userId: string; locationId: string }> {
  const roles = await seedRolesForClient(DEMO_CLIENT);
  await seedCatalogDefaultsForClient(DEMO_CLIENT).catch(() => { /* already seeded */ });

  await prisma.clientSettings.upsert({
    where: { clientId: DEMO_CLIENT },
    create: { clientId: DEMO_CLIENT, businessName: 'Demo Boutique' },
    update: {}
  });

  /*
   * MAIN-STORE by code, because that is what the suites look for by name. A second location with
   * the same code would send them at an empty one, so this is found-or-made rather than made.
   */
  let location = await prisma.stockLocation.findFirst({ where: { clientId: DEMO_CLIENT, code: 'MAIN-STORE' } });
  if (!location) {
    location = await prisma.stockLocation.create({
      data: { clientId: DEMO_CLIENT, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE', active: true }
    });
  }

  /*
   * The admin the suites sign in as. Its password is reset to a fresh random one every time, so
   * there is no credential sitting in the repository -- the suites mint their own token from the
   * user row and never need to know it.
   */
  let user = await prisma.user.findFirst({ where: { clientId: DEMO_CLIENT, email: DEMO_EMAIL } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        clientId: DEMO_CLIENT, email: DEMO_EMAIL, name: 'Demo Admin',
        password: await AuthService.hashPassword(require('crypto').randomBytes(12).toString('base64url')),
        status: 'ACTIVE'
      }
    });
  } else if (user.status !== 'ACTIVE') {
    user = await prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
  }
  const hasRole = await prisma.userRole.findFirst({ where: { userId: user.id, roleId: roles.SUPER_ADMIN } });
  if (!hasRole) await prisma.userRole.create({ data: { userId: user.id, roleId: roles.SUPER_ADMIN } });

  /*
   * Something to sort, price and sell. verify-audit-fixes sorts the inventory overview by quantity
   * and wants a location holding more than three of something, so the quantities are spread on
   * purpose rather than all being the same.
   */
  const want = [
    { code: 'DEMO-SAREE-1', title: 'Demo Kanchipuram Saree', price: 12000, qty: 12 },
    { code: 'DEMO-SAREE-2', title: 'Demo Mysore Silk Saree', price: 6400, qty: 7 },
    { code: 'DEMO-KURTI-1', title: 'Demo Cotton Kurti', price: 1450, qty: 25 },
    { code: 'DEMO-LEHENGA-1', title: 'Demo Bridal Lehenga', price: 38000, qty: 4 }
  ];
  for (const [i, w] of want.entries()) {
    const existing = await prisma.product.findFirst({ where: { clientId: DEMO_CLIENT, productCode: w.code } });
    if (existing) continue;
    const product = await prisma.product.create({
      data: {
        clientId: DEMO_CLIENT, productCode: w.code, title: w.title, slug: `demo-${w.code.toLowerCase()}`,
        category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: w.price, status: 'ACTIVE',
        publishedAt: new Date(Date.now() - i * 60_000)
      }
    });
    const variant = await prisma.productVariant.create({
      data: {
        clientId: DEMO_CLIENT, productId: product.id, sku: `${w.code}-V`, variantCode: `${w.code}-VC`,
        size: 'Free Size', colorName: 'Maroon', sellingPrice: w.price, averageCost: Math.round(w.price * 0.6)
      }
    });
    await prisma.inventoryStock.create({
      data: { clientId: DEMO_CLIENT, variantId: variant.id, locationId: location.id, quantity: w.qty, reservedQty: 0 }
    });
  }

  return { clientId: DEMO_CLIENT, userId: user.id, locationId: location.id };
}

/* Run it directly: npx tsx src/scripts/support/demoClient.ts */
if (require.main === module) {
  ensureDemoClient()
    .then(r => console.log('demo-client ready:', JSON.stringify(r)))
    .catch(e => { console.error('could not make demo-client:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
