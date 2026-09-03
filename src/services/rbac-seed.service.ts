import { prisma } from '../lib/prisma';

// Canonical permission/role taxonomy for a new client. This is the single source of
// truth -- backend/src/scripts/seed-rbac.ts (the standalone script) and the Platform
// Console's "onboard a new client" flow both call `seedRolesForClient` below rather
// than duplicating this list, to avoid the drift that existed across three older,
// disagreeing seed scripts (see SUPER_ADMIN_PLAN.md).
export const RBAC_DATA = {
  permissions: [
    { key: 'sales_order:view', description: 'View sales orders' },
    { key: 'sales_order:create', description: 'Create sales orders' },
    { key: 'sales_order:update', description: 'Update sales orders' },
    { key: 'sales_order:confirm', description: 'Confirm sales orders' },
    { key: 'sales_order:cancel', description: 'Cancel sales orders' },

    { key: 'dispatch:view', description: 'View dispatches' },
    { key: 'dispatch:create', description: 'Create dispatches' },

    { key: 'return:view', description: 'View returns' },
    { key: 'return:create', description: 'Request a return' },
    { key: 'return:receive', description: 'Mark a return as received' },
    { key: 'return:inspect', description: 'Inspect returned items and set disposition' },
    { key: 'return:complete', description: 'Complete or reject a return' },

    { key: 'inventory:view', description: 'View inventory and variants' },
    { key: 'inventory:receive', description: 'Receive new stock' },
    { key: 'inventory:adjust', description: 'Adjust inventory quantities' },
    { key: 'inventory:transfer', description: 'Transfer stock between locations' },

    { key: 'customer:view', description: 'View customers' },
    { key: 'customer:create', description: 'Create customers' },
    { key: 'customer:update', description: 'Update customers' },

    { key: 'product:view', description: 'View products and variants' },
    { key: 'product:create', description: 'Create products and variants' },
    { key: 'product:update', description: 'Update products, variants, and images' },
    { key: 'product:delete', description: 'Archive, trash, or permanently delete products' },

    { key: 'supplier:view', description: 'View suppliers' },
    { key: 'supplier:create', description: 'Create suppliers' },
    { key: 'supplier:update', description: 'Update suppliers' },
    { key: 'supplier:delete', description: 'Delete suppliers' },

    { key: 'purchase_order:view', description: 'View purchase orders' },
    { key: 'purchase_order:create', description: 'Create purchase orders' },
    { key: 'purchase_order:update', description: 'Update purchase order status' },
    { key: 'purchase_order:receive', description: 'Receive goods against a purchase order' },

    { key: 'stock_count:view', description: 'View stock counts' },
    { key: 'stock_count:create', description: 'Create and start stock counts' },
    { key: 'stock_count:update', description: 'Record counted quantities' },
    { key: 'stock_count:complete', description: 'Complete a stock count and post corrections' },

    { key: 'dashboard:view', description: 'View dashboard summary, reports, and search' },

    { key: 'admin:locations', description: 'Manage stock locations' },
    { key: 'admin:users', description: 'Manage users and roles' },
    { key: 'admin:catalog', description: 'Manage catalog categories and attributes' },
  ],
  roles: {
    SUPER_ADMIN: { description: 'Super Administrator', permissions: ['*'] },
    ADMIN: {
      description: 'Administrator',
      permissions: [
        'sales_order:view', 'sales_order:create', 'sales_order:update', 'sales_order:confirm', 'sales_order:cancel',
        'dispatch:view', 'dispatch:create',
        'return:view', 'return:create', 'return:receive', 'return:inspect', 'return:complete',
        'inventory:view', 'inventory:receive', 'inventory:adjust', 'inventory:transfer',
        'customer:view', 'customer:create', 'customer:update',
        'product:view', 'product:create', 'product:update', 'product:delete',
        'supplier:view', 'supplier:create', 'supplier:update', 'supplier:delete',
        'purchase_order:view', 'purchase_order:create', 'purchase_order:update', 'purchase_order:receive',
        'stock_count:view', 'stock_count:create', 'stock_count:update', 'stock_count:complete',
        'dashboard:view',
        'admin:locations', 'admin:catalog', 'admin:users'
      ]
    },
    SALES: {
      description: 'Sales Representative',
      permissions: [
        'sales_order:view', 'sales_order:create', 'sales_order:update', 'sales_order:confirm',
        'customer:view', 'customer:create', 'customer:update',
        'product:view',
        'dashboard:view'
      ]
    },
    WAREHOUSE: {
      description: 'Warehouse Staff',
      permissions: [
        'sales_order:view', 'dispatch:view', 'dispatch:create',
        'return:view', 'return:create', 'return:receive', 'return:inspect', 'return:complete',
        'inventory:view', 'inventory:receive', 'inventory:transfer',
        'product:view',
        'purchase_order:view', 'purchase_order:receive',
        'stock_count:view', 'stock_count:create', 'stock_count:update', 'stock_count:complete',
        'dashboard:view'
      ]
    },
    INVENTORY_MANAGER: {
      description: 'Inventory Manager',
      permissions: [
        'inventory:view', 'inventory:receive', 'inventory:adjust', 'inventory:transfer',
        'product:view', 'product:create', 'product:update',
        'supplier:view', 'supplier:create', 'supplier:update',
        'purchase_order:view', 'purchase_order:create', 'purchase_order:update', 'purchase_order:receive',
        'stock_count:view', 'stock_count:create', 'stock_count:update', 'stock_count:complete',
        'dashboard:view',
        'admin:locations', 'admin:catalog'
      ]
    }
  }
} as const;

// Runs `items` through `fn` with at most `limit` in flight at once. Prisma's own
// connection pool here caps out at 17 (see DATABASE_URL) -- a bare Promise.all over
// all ~100 upserts this function does blows past that and queries start timing out
// waiting for a free connection, which is worse than running them one at a time.
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function seedRolesForClient(clientId: string) {
  const CONCURRENCY = 8;

  await prisma.permission.createMany({
    data: [...RBAC_DATA.permissions],
    skipDuplicates: true
  });
  
  const permissionEntries = await prisma.permission.findMany();
  const permissionMap = new Map(permissionEntries.map(p => [p.key, p.id]));

  const roleEntries = await mapWithConcurrency(Object.entries(RBAC_DATA.roles), CONCURRENCY, async ([roleName, roleData]) => {
    const role = await prisma.role.upsert({
      where: { clientId_name: { clientId, name: roleName } },
      update: { description: roleData.description },
      create: { clientId, name: roleName, description: roleData.description }
    });
    return { roleName, role, roleData };
  });

  const roleIds: Record<string, string> = {};
  for (const { roleName, role } of roleEntries) roleIds[roleName] = role.id;

  const rolePermissionJobs = roleEntries.flatMap(({ roleName, role, roleData }) => {
    if (roleName === 'SUPER_ADMIN') return [];
    return roleData.permissions
      .filter(permKey => permKey !== '*')
      .map(permKey => ({ roleId: role.id, permissionId: permissionMap.get(permKey) }))
      .filter((job): job is { roleId: string; permissionId: string } => !!job.permissionId);
  });

  if (rolePermissionJobs.length > 0) {
    await prisma.rolePermission.createMany({
      data: rolePermissionJobs,
      skipDuplicates: true
    });
  }

  return roleIds;
}
