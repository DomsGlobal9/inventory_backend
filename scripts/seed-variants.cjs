const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CLIENT_ID = 'demo-client';

// Seed variants for jhgf and a couple other products
const seedData = [
  {
    productId: '405e00e6-bb92-405d-b087-2dbb908c124a', // jhgf
    variants: [
      { sku: 'JHGF-RED-S',  size: 'S', colorName: 'Red',   hexCode: '#EF4444', quantity: 12, reorderLevel: 5 },
      { sku: 'JHGF-RED-M',  size: 'M', colorName: 'Red',   hexCode: '#EF4444', quantity: 8,  reorderLevel: 5 },
      { sku: 'JHGF-RED-L',  size: 'L', colorName: 'Red',   hexCode: '#EF4444', quantity: 0,  reorderLevel: 5 },
      { sku: 'JHGF-BLU-S',  size: 'S', colorName: 'Blue',  hexCode: '#3B82F6', quantity: 20, reorderLevel: 5 },
      { sku: 'JHGF-BLU-M',  size: 'M', colorName: 'Blue',  hexCode: '#3B82F6', quantity: 3,  reorderLevel: 5 },
      { sku: 'JHGF-GRN-M',  size: 'M', colorName: 'Green', hexCode: '#10B981', quantity: 15, reorderLevel: 5 },
    ]
  },
  {
    productId: '7cc5b587-0c66-4d5b-8acc-be3525fce036', // hbgv
    variants: [
      { sku: 'HBGV-GLD-XS', size: 'XS', colorName: 'Gold',  hexCode: '#F59E0B', quantity: 5,  reorderLevel: 3 },
      { sku: 'HBGV-GLD-S',  size: 'S',  colorName: 'Gold',  hexCode: '#F59E0B', quantity: 18, reorderLevel: 3 },
      { sku: 'HBGV-GLD-M',  size: 'M',  colorName: 'Gold',  hexCode: '#F59E0B', quantity: 22, reorderLevel: 3 },
      { sku: 'HBGV-BLK-S',  size: 'S',  colorName: 'Black', hexCode: '#1F2937', quantity: 0,  reorderLevel: 3 },
      { sku: 'HBGV-BLK-M',  size: 'M',  colorName: 'Black', hexCode: '#1F2937', quantity: 2,  reorderLevel: 3 },
    ]
  }
];

async function main() {
  console.log('Seeding demo variants...');

  for (const { productId, variants } of seedData) {
    for (const v of variants) {
      try {
        await prisma.productVariant.upsert({
          where: { clientId_sku: { clientId: CLIENT_ID, sku: v.sku } },
          update: { quantity: v.quantity, reorderLevel: v.reorderLevel },
          create: {
            productId,
            clientId: CLIENT_ID,
            sku: v.sku,
            size: v.size,
            colorName: v.colorName,
            hexCode: v.hexCode,
            quantity: v.quantity,
            reorderLevel: v.reorderLevel,
          }
        });
        console.log('  ✓', v.sku);
      } catch (err) {
        console.log('  ✗', v.sku, err.message);
      }
    }
  }

  console.log('\nDone!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
