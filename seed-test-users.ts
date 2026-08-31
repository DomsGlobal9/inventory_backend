import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import fs from 'fs';

const prisma = new PrismaClient();
const CLIENT_ID = 'demo-client';

async function seed() {
  console.log('Seeding RBAC test users...');

  // 1. Define Permissions
  const permissionsData = [
    { key: 'sales_order:view', description: 'View sales orders' },
    { key: 'sales_order:create', description: 'Create sales orders' },
    { key: 'sales_order:update', description: 'Update sales orders' },
    { key: 'sales_order:cancel', description: 'Cancel sales orders' },
    { key: 'sales_order:confirm', description: 'Confirm sales orders' },
    { key: 'inventory:view', description: 'View inventory' },
    { key: 'inventory:update', description: 'Update inventory' },
    { key: 'inventory:create', description: 'Create inventory' },
    { key: 'dispatch:create', description: 'Create dispatches' },
    { key: 'dispatch:view', description: 'View dispatches' },
    { key: 'customer:view', description: 'View customers' },
    { key: 'customer:update', description: 'Update customers' },
  ];

  // Insert permissions
  for (const p of permissionsData) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: {},
      create: p,
    });
  }

  const allPerms = await prisma.permission.findMany();
  const permMap = allPerms.reduce((acc, p) => ({ ...acc, [p.key]: p.id }), {} as any);

  // 2. Define Roles and their permission keys
  const roleDefinitions = [
    {
      name: 'ADMIN',
      description: 'Full access to everything',
      perms: permissionsData.map(p => p.key)
    },
    {
      name: 'STAFF',
      description: 'Warehouse staff (no customer edits or order creations)',
      perms: ['inventory:view', 'inventory:update', 'sales_order:view', 'sales_order:confirm', 'dispatch:create', 'dispatch:view']
    },
    {
      name: 'GUEST',
      description: 'Read-only access',
      perms: ['sales_order:view', 'inventory:view', 'dispatch:view', 'customer:view']
    }
  ];

  const roleMap: any = {};
  for (const rd of roleDefinitions) {
    const role = await prisma.role.upsert({
      where: { clientId_name: { clientId: CLIENT_ID, name: rd.name } },
      update: { description: rd.description },
      create: { clientId: CLIENT_ID, name: rd.name, description: rd.description },
    });
    roleMap[rd.name] = role.id;

    // Link permissions
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: rd.perms.map(k => ({ roleId: role.id, permissionId: permMap[k] }))
    });
  }

  // 3. Define Users
  const passwordHash = await bcrypt.hash('password123', 10);
  const users = [
    { name: 'Admin User', email: 'admin@demo.com', role: 'ADMIN' },
    { name: 'Warehouse Staff', email: 'staff@demo.com', role: 'STAFF' },
    { name: 'Read Only Guest', email: 'guest@demo.com', role: 'GUEST' }
  ];

  const credentialsOutput: string[] = ['Test Login Credentials for RBAC', '-----------------------------', `Client ID for all: ${CLIENT_ID}`, ''];

  for (const u of users) {
    const user = await prisma.user.upsert({
      where: { clientId_email: { clientId: CLIENT_ID, email: u.email } },
      update: { password: passwordHash, status: 'ACTIVE' },
      create: {
        clientId: CLIENT_ID,
        name: u.name,
        email: u.email,
        password: passwordHash,
        status: 'ACTIVE'
      }
    });

    // Link User to Role
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: roleMap[u.role] }
    });

    credentialsOutput.push(`Role: ${u.role}`);
    credentialsOutput.push(`Email: ${u.email}`);
    credentialsOutput.push(`Password: password123`);
    credentialsOutput.push('');
  }

  // Write credentials to file
  fs.writeFileSync('login-creds.txt', credentialsOutput.join('\n'));
  console.log('✅ Users seeded and login-creds.txt generated successfully!');
}

seed()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
