const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Migrating client-001 → demo-client...');

  const products = await prisma.product.updateMany({
    where: { clientId: 'client-001' },
    data: { clientId: 'demo-client' }
  });

  const variants = await prisma.productVariant.updateMany({
    where: { clientId: 'client-001' },
    data: { clientId: 'demo-client' }
  });

  const txns = await prisma.inventoryTransaction.updateMany({
    where: { clientId: 'client-001' },
    data: { clientId: 'demo-client' }
  });

  console.log('Products migrated:', products.count);
  console.log('Variants migrated:', variants.count);
  console.log('Transactions migrated:', txns.count);
  console.log('Done!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
