import { PrismaClient, UserStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Must match the clientId already used by dev data and frontend/.env's VITE_CLIENT_ID.
const DEFAULT_CLIENT_ID = process.env.SEED_CLIENT_ID || 'demo-client';

const permissions = [
  'sales_order:create', 'sales_order:view', 'sales_order:update', 'sales_order:confirm', 'sales_order:cancel',
  'dispatch:view', 'dispatch:create', 'dispatch:execute', 'dispatch:cancel',
  'inventory:view', 'inventory:adjust', 'inventory:receive', 'inventory:transfer',
  'return:view', 'return:create', 'return:receive', 'return:inspect', 'return:complete',
  'customer:view', 'customer:create', 'customer:update',
  'user:view', 'user:create', 'user:update', 'user:disable',
  'report:view'
];

const rolesDefinition = [
  {
    name: 'SUPER_ADMIN',
    permissions: permissions // all
  },
  {
    name: 'SALES',
    permissions: [
      'customer:view', 'customer:create', 'customer:update',
      'sales_order:view', 'sales_order:create', 'sales_order:update', 'sales_order:confirm', 'sales_order:cancel'
    ]
  },
  {
    name: 'WAREHOUSE',
    permissions: [
      'inventory:view', 'inventory:receive', 'inventory:adjust',
      'dispatch:view', 'dispatch:create', 'dispatch:execute',
      'return:view', 'return:receive', 'return:inspect', 'return:complete'
    ]
  }
];

async function main() {
  console.log('Seeding RBAC...');

  // 1. Create Permissions
  for (const p of permissions) {
    await prisma.permission.upsert({
      where: { key: p },
      update: {},
      create: { key: p, description: `Permission for ${p}` }
    });
  }

  // 2. Create Roles
  for (const roleDef of rolesDefinition) {
    const role = await prisma.role.upsert({
      where: {
        clientId_name: { clientId: DEFAULT_CLIENT_ID, name: roleDef.name }
      },
      update: {},
      create: {
        clientId: DEFAULT_CLIENT_ID,
        name: roleDef.name,
        description: `${roleDef.name} Role`
      }
    });

    // 3. Assign Permissions to Role
    for (const p of roleDef.permissions) {
      const permission = await prisma.permission.findUnique({ where: { key: p } });
      if (permission) {
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: { roleId: role.id, permissionId: permission.id }
          },
          update: {},
          create: {
            roleId: role.id,
            permissionId: permission.id
          }
        });
      }
    }
  }

  // 4. Create an Admin User
  const salt = await bcrypt.genSalt(10);
  const password = await bcrypt.hash('password123', salt);

  const adminRole = await prisma.role.findUnique({
    where: { clientId_name: { clientId: DEFAULT_CLIENT_ID, name: 'SUPER_ADMIN' } }
  });

  if (adminRole) {
    const user = await prisma.user.upsert({
      where: {
        clientId_email: { clientId: DEFAULT_CLIENT_ID, email: 'admin@example.com' }
      },
      update: {},
      create: {
        clientId: DEFAULT_CLIENT_ID,
        name: 'Super Admin',
        email: 'admin@example.com',
        password,
        status: UserStatus.ACTIVE
      }
    });

    await prisma.userRole.upsert({
      where: {
        userId_roleId: { userId: user.id, roleId: adminRole.id }
      },
      update: {},
      create: {
        userId: user.id,
        roleId: adminRole.id
      }
    });
  }

  console.log('RBAC Seeded Successfully.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
