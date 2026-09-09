import { prisma } from '../lib/prisma';
import { ALL_PERMISSION_KEYS, getPermission, WILDCARD_PERMISSION, WILDCARD_LABEL } from '../config/permissions';

// Canonical permission/role taxonomy for a new client. This is the single source of
// truth -- backend/src/scripts/seed-rbac.ts (the standalone script) and the Platform
// Console's "onboard a new client" flow both call `seedRolesForClient` below rather
// than duplicating this list, to avoid the drift that existed across three older,
// disagreeing seed scripts (see SUPER_ADMIN_PLAN.md).
export const RBAC_DATA = {
  // The catalogue is not repeated here. It lives in config/permissions.ts, which is what the
  // middleware, the API and every other module read -- a second hand-written copy is how a key
  // ends up guarding a route while being absent from the list nobody can be granted from.
  permissions: ALL_PERMISSION_KEYS.map(key => ({ key, description: getPermission(key)?.label ?? key })),
  roles: {
    SUPER_ADMIN: { description: 'Super Administrator', permissions: ['*'] },

    ADMIN: {
      description: 'Administrator',
      permissions: [
        'sales_order:view', 'sales_order:create', 'sales_order:update', 'sales_order:confirm', 'sales_order:cancel',
        'dispatch:create',
        'return:create', 'return:receive', 'return:inspect', 'return:complete',
        'inventory:receive', 'inventory:adjust', 'inventory:transfer',
        'customer:create', 'customer:update',
        'product:create', 'product:update', 'product:delete',
        'supplier:create', 'supplier:update', 'supplier:delete',
        'purchase_order:create', 'purchase_order:update', 'purchase_order:receive',
        'stock_count:create', 'stock_count:update', 'stock_count:complete',
        'dashboard:view', 'report:financial', 'cost:manage', 'tryon:generate',
        'admin:locations', 'admin:catalog', 'admin:users', 'team:view_password'
      ]
    },

    // A salesperson sells. They do not need to know what the shop paid, and until now they
    // could read its whole financial position through dashboard:view.
    SALES: {
      description: 'Sales Representative',
      permissions: [
        'sales_order:create', 'sales_order:update', 'sales_order:confirm',
        'customer:create', 'customer:update',
        'product:view',
        'dashboard:view'
      ]
    },

    // Moves stock. Sees quantities, not money.
    WAREHOUSE: {
      description: 'Warehouse Staff',
      permissions: [
        'sales_order:view', 'dispatch:create',
        'return:create', 'return:receive', 'return:inspect', 'return:complete',
        'inventory:receive', 'inventory:transfer',
        'product:view',
        'purchase_order:receive',
        'stock_count:create', 'stock_count:update', 'stock_count:complete',
        'dashboard:view', 'report:view'
      ]
    },

    // Buys, so needs the money. Cannot manage the team.
    INVENTORY_MANAGER: {
      description: 'Inventory Manager',
      permissions: [
        'inventory:receive', 'inventory:adjust', 'inventory:transfer',
        'product:create', 'product:update',
        'supplier:create', 'supplier:update',
        'purchase_order:create', 'purchase_order:update', 'purchase_order:receive',
        'stock_count:create', 'stock_count:update', 'stock_count:complete',
        'dashboard:view', 'report:financial', 'cost:manage', 'tryon:generate',
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
    // The wildcard is stored like any other permission so it can be granted, joined and
    // revoked. It is not part of the catalogue, so it never appears as a box on the roles
    // screen -- see the note in config/permissions.
    data: [...RBAC_DATA.permissions, { key: WILDCARD_PERMISSION, description: WILDCARD_LABEL }],
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

  // SUPER_ADMIN used to be skipped here and left with no permissions at all, because the
  // middleware granted it everything on the strength of its name. It is now granted '*' like
  // any other row, which is what makes removing that bypass safe.
  const rolePermissionJobs = roleEntries.flatMap(({ roleName, role, roleData }) => {
    return roleData.permissions
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
