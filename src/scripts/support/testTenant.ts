/**
 * The long-lived shop that the day book, reports, snapshot and storefront suites run against.
 *
 * Those suites were written against one particular tenant, created once by a run of
 * verify-new-client-e2e, found by a hard-coded email and logged into with a hard-coded password.
 * When that tenant went -- almost certainly with the database move -- all five stopped at their
 * first line with "Test tenant not found", and stayed stopped: nothing could bring it back.
 *
 * This recreates it on demand, the way onboarding does (roles, catalogue defaults, a MAIN-STORE,
 * settings, an owner) but without emailing anybody, and gives it a little real history: stock
 * received and a sale shipped, so a day book has movements to balance and a report has money
 * to add up.
 *
 * The password is not written down anywhere. It is reset to a fresh random one on every run and
 * handed back, so there is no credential in the repository to leak, and no suite depends on
 * somebody remembering it.
 *
 * Guarded hard: it only ever touches the one tenant id below. An account with the test email
 * under any other tenant is refused rather than "fixed", because resetting the password of a
 * real person's login is not something a test is allowed to do by accident.
 */
import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { AuthService } from '../../services/auth.service';
import { seedRolesForClient } from '../../services/rbac-seed.service';
import { seedCatalogDefaultsForClient } from '../../services/catalog-seed.service';
import { inventoryMutationService } from '../../services/inventory-mutation.service';
import { salesOrderService } from '../../services/sales-order.service';
import { dispatchService } from '../../services/dispatch.service';
import { SnapshotService } from '../../services/snapshot.service';

export const TEST_TENANT_ID = process.env.TEST_TENANT_ID || 'verify-suites-tenant';
export const TEST_TENANT_EMAIL = process.env.TEST_TENANT_EMAIL || 'verify-suites@example.com';

export interface TestTenant {
  clientId: string;
  email: string;
  password: string;
  locationId: string;
}

export async function ensureTestTenant(): Promise<TestTenant> {
  const clash = await prisma.user.findFirst({
    where: { email: TEST_TENANT_EMAIL, NOT: { clientId: TEST_TENANT_ID } },
    select: { clientId: true }
  });
  if (clash) {
    throw new Error(
      `${TEST_TENANT_EMAIL} already belongs to tenant ${clash.clientId}, not ${TEST_TENANT_ID}. ` +
      `Refusing to touch it -- set TEST_TENANT_EMAIL to an address the suites own.`
    );
  }

  const clientId = TEST_TENANT_ID;
  const password = crypto.randomBytes(12).toString('base64url');
  const hashed = await AuthService.hashPassword(password);

  let owner = await prisma.user.findFirst({ where: { clientId, email: TEST_TENANT_EMAIL } });

  if (!owner) {
    console.log(`[test tenant] ${clientId} is missing -- recreating it`);
    const roleIds = await seedRolesForClient(clientId);
    await seedCatalogDefaultsForClient(clientId);
    await prisma.clientSettings.upsert({
      where: { clientId },
      create: { clientId, businessName: 'Verification Boutique' },
      update: {}
    });
    owner = await prisma.user.create({
      data: { clientId, name: 'Verification Owner', email: TEST_TENANT_EMAIL, password: hashed, status: 'ACTIVE' }
    });
    await prisma.userRole.create({ data: { userId: owner.id, roleId: roleIds.SUPER_ADMIN } });
  } else {
    await prisma.user.update({ where: { id: owner.id }, data: { password: hashed, status: 'ACTIVE' } });
  }

  let location = await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
  if (!location) {
    location = await prisma.stockLocation.create({
      data: { clientId, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true }
    });
  }

  // A second place to keep stock. The storefront suite scopes a connection to one location and
  // proves the other's stock and prices do not leak through -- which needs there to be another.
  const godown = await prisma.stockLocation.findFirst({ where: { clientId, code: 'GODOWN' } });
  if (!godown) {
    await prisma.stockLocation.create({
      data: { clientId, code: 'GODOWN', name: 'Godown', type: 'WAREHOUSE', active: true }
    });
  }

  await ensureHistory(clientId, location.id, owner.id);

  return { clientId, email: TEST_TENANT_EMAIL, password, locationId: location.id };
}

/** Stock received and a sale shipped, once. A shop with no history balances trivially. */
async function ensureHistory(clientId: string, locationId: string, userId: string) {
  const already = await prisma.inventoryTransaction.count({ where: { clientId } });
  if (already > 0) return;

  const product = await prisma.product.create({
    data: {
      clientId, productCode: 'PRD-VERIFY-1', title: 'Pochampally Ikat Saree',
      slug: `verify-ikat-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR',
      basePrice: 4200, status: 'ACTIVE'
    }
  });

  const variants = [];
  for (const [colour, price] of [['Indigo', 4200], ['Rust', 3900]] as const) {
    const variant = await prisma.productVariant.create({
      data: {
        clientId, productId: product.id, sku: `VERIFY-IKAT-${colour.toUpperCase()}`,
        variantCode: `VAR-VERIFY-${colour.toUpperCase()}`, colorName: colour, size: 'Free',
        sellingPrice: price, costPrice: 2600, averageCost: 0
      }
    });
    await inventoryMutationService.applyMovement({
      clientId, variantId: variant.id, locationId, movementType: 'IN', reason: 'PURCHASE_RECEIPT',
      quantityDelta: 20, unitCost: 2600, notes: 'Opening stock for the verification tenant', createdBy: userId
    });
    variants.push(variant);
  }

  let customer = await prisma.customer.findFirst({ where: { clientId } });
  if (!customer) {
    customer = await prisma.customer.create({
      data: { clientId, customerCode: 'CUS-VERIFY-1', name: 'Verification Customer', status: 'ACTIVE' }
    });
  }

  const order: any = await salesOrderService.createFullOrder(clientId, locationId, {
    customer: { id: customer.id },
    items: variants.map(v => ({ variantId: v.id, quantity: 2 }))
  });
  await salesOrderService.confirmOrder(clientId, order.id);
  await dispatchService.createDispatch(clientId, order.id, order.items.map((i: any) => ({ salesOrderItemId: i.id, quantity: 2 })));

  /*
   * Dated in the past, as a real shop's would be.
   *
   * The day book and snapshot suites ask about YESTERDAY -- its closing, its stored snapshot, and
   * whether today opens where yesterday closed. A shop whose whole history happened thirty
   * seconds ago has no yesterday, and those checks would be asking about nothing. So the stock
   * arrives three days back and the sale ships two days back: every timestamp that a report
   * reads to place an event in a day is moved together, so the history is consistent with itself.
   */
  const day = 24 * 60 * 60 * 1000;
  const received = new Date(Date.now() - 3 * day);
  const sold = new Date(Date.now() - 2 * day);

  await prisma.inventoryTransaction.updateMany({ where: { clientId, reason: 'PURCHASE_RECEIPT' }, data: { createdAt: received } });
  await prisma.inventoryTransaction.updateMany({ where: { clientId, NOT: { reason: 'PURCHASE_RECEIPT' } }, data: { createdAt: sold } });
  await prisma.salesOrder.updateMany({ where: { clientId }, data: { createdAt: sold } });
  await prisma.dispatch.updateMany({ where: { clientId }, data: { createdAt: sold, dispatchedAt: sold } });
  await prisma.salesLedger.updateMany({ where: { clientId }, data: { transactionDate: sold } });

  // What the hourly snapshot job would have written on each of those nights.
  await new SnapshotService().catchUpTenant(clientId);

  console.log(`[test tenant] history written: 40 received three days ago, 4 sold and shipped two days ago`);
}
