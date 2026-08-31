import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting Multi-Location Data Migration...');

  // 1. Get all distinct clients
  const products = await prisma.product.findMany({
    select: { clientId: true },
    distinct: ['clientId']
  });
  
  if (products.length === 0) {
    console.log('No clients found. Assuming fresh DB.');
    return;
  }

  const clientIds = products.map(p => p.clientId);
  console.log(`Found ${clientIds.length} clients to migrate.`);

  for (const clientId of clientIds) {
    console.log(`\nMigrating Client: ${clientId}`);

    // 2. Ensure default location exists
    const mainStore = await prisma.stockLocation.upsert({
      where: {
        clientId_code: {
          clientId,
          code: 'MAIN-STORE'
        }
      },
      update: {},
      create: {
        clientId,
        code: 'MAIN-STORE',
        name: 'Main Store',
        type: 'STORE',
        active: true
      }
    });
    console.log(`  -> Ensured location: ${mainStore.code} (${mainStore.id})`);

    // 3. Migrate InventoryStock
    const variants = await prisma.productVariant.findMany({
      where: { clientId }
    });

    let migratedStock = 0;
    for (const variant of variants) {
      // NOTE: variant still has quantity and reservedQty fields here because we haven't removed them yet!
      // In TS, if Prisma generated types already removed them, we use any. 
      // But we just pushed schema with them STILL INTACT, so they exist.
      const qty = (variant as any).quantity || 0;
      const res = (variant as any).reservedQty || 0;

      await prisma.inventoryStock.upsert({
        where: {
          variantId_locationId: {
            variantId: variant.id,
            locationId: mainStore.id
          }
        },
        update: {
          quantity: qty,
          reservedQty: res
        },
        create: {
          clientId: clientId,
          variantId: variant.id,
          locationId: mainStore.id,
          quantity: qty,
          reservedQty: res
        }
      });
      migratedStock++;
    }
    console.log(`  -> Migrated ${migratedStock} variants to InventoryStock.`);

    // 4. Update SalesOrders
    const ordersRes = await prisma.salesOrder.updateMany({
      where: { 
        clientId,
        locationId: null 
      },
      data: {
        locationId: mainStore.id,
        channel: 'POS'
      }
    });
    console.log(`  -> Backfilled ${ordersRes.count} SalesOrders with locationId.`);

    // 5. Update InventoryReservations
    const resRes = await prisma.inventoryReservation.updateMany({
      where: { 
        clientId,
        locationId: null 
      },
      data: {
        locationId: mainStore.id
      }
    });
    console.log(`  -> Backfilled ${resRes.count} InventoryReservations with locationId.`);

    // 6. Update InventoryTransactions
    const transRes = await prisma.inventoryTransaction.updateMany({
      where: { 
        clientId,
        locationId: null 
      },
      data: {
        locationId: mainStore.id
      }
    });
    console.log(`  -> Backfilled ${transRes.count} InventoryTransactions with locationId.`);
  }

  console.log('\nMigration complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
