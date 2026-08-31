import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RBAC_DATA = {
  permissions: [
    // Sales Orders
    { key: 'sales_order:view', description: 'View sales orders' },
    { key: 'sales_order:create', description: 'Create sales orders' },
    { key: 'sales_order:update', description: 'Update sales orders' },
    { key: 'sales_order:confirm', description: 'Confirm sales orders' },
    { key: 'sales_order:cancel', description: 'Cancel sales orders' },
    
    // Dispatch
    { key: 'dispatch:view', description: 'View dispatches' },
    { key: 'dispatch:create', description: 'Create dispatches' },
    
    // Returns
    { key: 'returns:view', description: 'View returns' },
    { key: 'returns:create', description: 'Process returns' },
    
    // Inventory
    { key: 'inventory:view', description: 'View inventory and variants' },
    { key: 'inventory:receive', description: 'Receive new stock' },
    { key: 'inventory:adjust', description: 'Adjust inventory quantities' },
    { key: 'inventory:transfer', description: 'Transfer stock between locations' },
    
    // Customers
    { key: 'customer:view', description: 'View customers' },
    { key: 'customer:create', description: 'Create customers' },
    { key: 'customer:update', description: 'Update customers' },
    
    // Admin
    { key: 'admin:locations', description: 'Manage stock locations' },
    { key: 'admin:users', description: 'Manage users and roles' },
    { key: 'admin:catalog', description: 'Manage catalog categories and attributes' },
  ],
  roles: {
    SUPER_ADMIN: {
      description: 'Super Administrator',
      // Super admin implicitly has all permissions via middleware logic, 
      // but we can map them anyway for completeness.
      permissions: ['*']
    },
    ADMIN: {
      description: 'Administrator',
      permissions: [
        'sales_order:view', 'sales_order:create', 'sales_order:update', 'sales_order:confirm', 'sales_order:cancel',
        'dispatch:view', 'dispatch:create',
        'returns:view', 'returns:create',
        'inventory:view', 'inventory:receive', 'inventory:adjust', 'inventory:transfer',
        'customer:view', 'customer:create', 'customer:update',
        'admin:locations', 'admin:catalog'
      ]
    },
    SALES: {
      description: 'Sales Representative',
      permissions: [
        'sales_order:view', 'sales_order:create',
        'customer:view', 'customer:create'
      ]
    },
    WAREHOUSE: {
      description: 'Warehouse Staff',
      permissions: [
        'sales_order:view', 'dispatch:view', 'dispatch:create',
        'returns:view', 'returns:create',
        'inventory:view', 'inventory:receive', 'inventory:transfer'
      ]
    },
    INVENTORY_MANAGER: {
      description: 'Inventory Manager',
      permissions: [
        'inventory:view', 'inventory:receive', 'inventory:adjust', 'inventory:transfer',
        'admin:locations'
      ]
    }
  }
};

async function main() {
  console.log('Starting RBAC seeding...');

  // 1. Get all clients (or specifically demo-client)
  const clients = await prisma.user.findMany({
    select: { clientId: true },
    distinct: ['clientId']
  });

  if (clients.length === 0) {
    console.log('No clients found in the database. Run your main seed first.');
    return;
  }

  // 2. Upsert all permissions globally
  console.log('Upserting permissions...');
  const permissionMap = new Map();
  for (const perm of RBAC_DATA.permissions) {
    const p = await prisma.permission.upsert({
      where: { key: perm.key },
      update: { description: perm.description },
      create: { key: perm.key, description: perm.description }
    });
    permissionMap.set(p.key, p.id);
  }

  // 3. Process roles and role-permissions for each client
  for (const client of clients) {
    const clientId = client.clientId;
    console.log(`Processing roles for clientId: ${clientId}`);

    for (const [roleName, roleData] of Object.entries(RBAC_DATA.roles)) {
      // Upsert Role
      const role = await prisma.role.upsert({
        where: {
          clientId_name: {
            clientId: clientId,
            name: roleName
          }
        },
        update: { description: roleData.description },
        create: {
          clientId: clientId,
          name: roleName,
          description: roleData.description
        }
      });

      console.log(` - Upserted Role: ${roleName}`);

      // If it's SUPER_ADMIN and we want to skip explicit permission mapping because middleware handles it
      if (roleName === 'SUPER_ADMIN') continue;

      // Assign permissions to role
      for (const permKey of roleData.permissions) {
        if (permKey === '*') continue;
        const permissionId = permissionMap.get(permKey);
        if (permissionId) {
          await prisma.rolePermission.upsert({
            where: {
              roleId_permissionId: {
                roleId: role.id,
                permissionId: permissionId
              }
            },
            update: {},
            create: {
              roleId: role.id,
              permissionId: permissionId
            }
          });
        }
      }
    }
    
    // 4. Assign ADMIN to demo-client admin user if it exists
    if (clientId === 'demo-client') {
       const adminUser = await prisma.user.findUnique({ where: { clientId_email: { clientId: 'demo-client', email: 'admin@example.com' }}});
       const adminRole = await prisma.role.findUnique({ where: { clientId_name: { clientId: 'demo-client', name: 'SUPER_ADMIN' }}});
       
       if (adminUser && adminRole) {
          await prisma.userRole.upsert({
             where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id }},
             update: {},
             create: { userId: adminUser.id, roleId: adminRole.id }
          });
          console.log(`Assigned SUPER_ADMIN to admin@example.com`);
       }
    }
  }

  console.log('RBAC Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
