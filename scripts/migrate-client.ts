import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Migrating client-001 → demo-client...\n');

  const [products, variants, transactions] = await Promise.all([
    prisma.product.updateMany({
      where: { clientId: 'client-001' },
      data: { clientId: 'demo-client' }
    }),
    prisma.productVariant.updateMany({
      where: { clientId: 'client-001' },
      data: { clientId: 'demo-client' }
    }),
    prisma.inventoryTransaction.updateMany({
      where: { clientId: 'client-001' },
      data: { clientId: 'demo-client' }
    })
  ]);

  console.log(`✅ Products migrated:     ${products.count}`);
  console.log(`✅ Variants migrated:     ${variants.count}`);
  console.log(`✅ Transactions migrated: ${transactions.count}`);
  console.log('\n🎉 Done. All records are now under demo-client.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
