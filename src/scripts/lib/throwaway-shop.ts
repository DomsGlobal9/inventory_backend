/**
 * A throwaway shop for a suite that changes a shop's modules (26 Nov 2026). verify-suites-tenant is shared by the
 * Inventory, CRM and POS suites: since one-switch onboarding, a module change there (Logistics on/off) is a real change
 * every module is told about, and it rippled into the others' runs. So such suites make their own shop here, made the
 * way ScaleEzy makes one (the Console's onboarding: roles, owner, first store), with Inventory only, a SALES and a
 * WAREHOUSE person, one product and one customer, and remove it at the end (also if making it fails half-way).
 * LOCAL DATABASE ONLY. Its emails go to @example.invalid.
 */
import { prisma } from '../../lib/prisma';
import { AuthService } from '../../services/auth.service';

export type Throwaway = {
  clientId: string; locationId: string; customerId: string; variantId: string;
  tokens: Record<'SUPER_ADMIN' | 'SALES' | 'WAREHOUSE', string>;
  remove: () => Promise<void>;
};

/** Everything a local shop holds, gone. */
export async function removeShop(clientId: string) {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE client_id = $1)`, clientId).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE client_id = $1)`, clientId).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = $1)`, clientId).catch(() => undefined);
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = $1`, clientId); } catch { left++; } }
    if (!left) break;
  }
}

export async function makeThrowawayShop(tag: string): Promise<Throwaway> {
  for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
    if (!/localhost:55433/.test(process.env[k] ?? '')) throw new Error(`Refusing: ${k} is not the local database.`);
  }
  const { platformAdminService } = await import('../../services/platform-admin.service');
  const S = Date.now().toString(36);
  const made: any = await platformAdminService.onboardClient(`Throwaway ${tag} ${S}`, `Owner ${tag}`, `throwaway-${tag.toLowerCase()}-${S}@example.invalid`, null, { ownerPhone: '9848012345', modules: ['inventory'] } as any);
  const clientId: string = made.clientId;
  try {
    // Recorded like a Console client with Inventory only (no module is told: nothing else is on).
    await prisma.platformClient.upsert({ where: { clientId }, create: { clientId, name: `Throwaway ${tag}`, version: 1 }, update: {} });
    await prisma.clientModule.upsert({ where: { clientId_module: { clientId, module: 'inventory' } }, create: { clientId, module: 'inventory', on: true, source: 'console' }, update: {} });
    const owner = await prisma.user.findFirstOrThrow({ where: { clientId, roles: { some: { role: { name: 'SUPER_ADMIN' } } } } });
    const person = async (role: string) => {
      const r = await prisma.role.findFirstOrThrow({ where: { clientId, name: role } });
      const u = await prisma.user.create({ data: { clientId, name: `${role} person`, email: `throwaway-${role.toLowerCase()}-${S}@example.invalid`, password: 'x', status: 'ACTIVE' } as any });
      await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
      return u;
    };
    const sales = await person('SALES');
    const warehouse = await person('WAREHOUSE');
    const store = await prisma.stockLocation.findFirstOrThrow({ where: { clientId, active: true }, orderBy: { createdAt: 'asc' } });
    const p = await prisma.product.create({ data: { clientId, productCode: `TW-${S}`, slug: `tw-${S}`, title: 'Throwaway saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true } as any });
    const v = await prisma.productVariant.create({ data: { clientId, productId: p.id, variantCode: `TWV-${S}`, sku: `TWS-${S}`, sellingPrice: 1000 } as any });
    const customer = await prisma.customer.create({ data: { clientId, customerCode: `TWC-${S}`, name: 'Throwaway customer', phone: `9${String(Date.now()).slice(-9)}` } as any });
    const token = (u: any) => AuthService.generateToken({ userId: u.id, clientId, sessionVersion: u.sessionVersion } as any);
    return {
      clientId, locationId: store.id, customerId: customer.id, variantId: v.id,
      tokens: { SUPER_ADMIN: token(owner), SALES: token(sales), WAREHOUSE: token(warehouse) },
      remove: () => removeShop(clientId)
    };
  } catch (e) {
    await removeShop(clientId).catch(() => undefined);
    throw e;
  }
}
