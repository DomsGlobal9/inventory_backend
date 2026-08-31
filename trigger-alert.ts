import { prisma } from './src/lib/prisma';
import { InventoryMutationService } from './src/services/inventory-mutation.service';

const mutationService = new InventoryMutationService();

async function trigger() {
  const clientId = 'demo-client';
  const variantId = '2fc87aac-340e-4018-956f-5393123e781e';
  const locationId = '0ee137b8-033c-4b72-b2c9-a7d40dae1186'; 

  // Make sure existing alert is resolved, and stock is above 10
  const currentStock = await prisma.inventoryStock.findUnique({
    where: { variantId_locationId: { variantId, locationId } }
  });

  if (currentStock && currentStock.quantity <= 10) {
    console.log('Restocking to 20 to reset...');
    await mutationService.applyMovement({
      clientId, variantId, locationId,
      movementType: 'IN', reason: 'PURCHASE', quantityDelta: 20 - currentStock.quantity
    });
  }

  console.log('Triggering LOW STOCK alert now! Look at your browser! 🚀');
  await new Promise(r => setTimeout(r, 2000));

  await mutationService.applyMovement({
    clientId, variantId, locationId,
    movementType: 'OUT', reason: 'SALE', quantityDelta: -15
  });

  console.log('Done.');
}

trigger().finally(() => prisma.$disconnect());
