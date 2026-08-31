import { prisma } from './src/lib/prisma';
import { InventoryMutationService } from './src/services/inventory-mutation.service';

const mutationService = new InventoryMutationService();

async function runTest() {
  console.log('--- STARTING ALERT SYSTEM TEST ---');

  const clientId = 'demo-client';
  const variantId = '2fc87aac-340e-4018-956f-5393123e781e';
  const locationId = '0ee137b8-033c-4b72-b2c9-a7d40dae1186'; // Main Store

  // 1. Setup: Set Reorder Level to 10 and ensure stock is 50
  await prisma.productVariant.update({
    where: { id: variantId },
    data: { reorderLevel: 10 }
  });

  const currentStock = await prisma.inventoryStock.findUnique({
    where: { variantId_locationId: { variantId, locationId } }
  });

  if (currentStock && currentStock.quantity !== 50) {
    const diff = 50 - currentStock.quantity;
    await mutationService.applyMovement({
      clientId, variantId, locationId,
      movementType: 'IN', reason: 'PURCHASE', quantityDelta: diff
    });
  }

  console.log('✅ Setup complete: Stock is 50, Reorder Level is 10.');

  // Helper to dump alerts and events
  async function dumpState(step: string) {
    console.log(`\n--- STATE AFTER: ${step} ---`);
    const alerts = await prisma.inventoryAlert.findMany({
      where: { variantId, locationId }
    });
    console.log('ALERTS:');
    alerts.forEach(a => {
      console.log(`  - [${a.type}] ${a.title} (Qty: ${a.currentQuantity}) - Resolved: ${a.isResolved}`);
    });

    const events = await prisma.inventoryEvent.findMany({
      where: { variantId, locationId },
      orderBy: { createdAt: 'desc' },
      take: 1
    });
    console.log('LATEST EVENT:');
    events.forEach(e => {
      console.log(`  - ${e.eventType} (Status: ${e.status}) | Qty: ${e.previousQuantity} -> ${e.quantity}`);
    });
  }

  // 2. Drop stock to 5 (LOW STOCK)
  console.log('\n> Applying movement: -45 (Sale)');
  await mutationService.applyMovement({
    clientId, variantId, locationId,
    movementType: 'OUT', reason: 'SALE', quantityDelta: -45
  });
  await dumpState('LOW STOCK SCENARIO');

  // 3. Drop stock to 0 (OUT OF STOCK)
  console.log('\n> Applying movement: -5 (Sale)');
  await mutationService.applyMovement({
    clientId, variantId, locationId,
    movementType: 'OUT', reason: 'SALE', quantityDelta: -5
  });
  await dumpState('OUT OF STOCK SCENARIO');

  // 4. Raise stock to 20 (RESTOCK)
  console.log('\n> Applying movement: +20 (Purchase)');
  await mutationService.applyMovement({
    clientId, variantId, locationId,
    movementType: 'IN', reason: 'PURCHASE', quantityDelta: 20
  });
  await dumpState('RESTOCK SCENARIO');

  console.log('\n--- TEST COMPLETE ---');
}

runTest()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
