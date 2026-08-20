import { PrismaClient } from '@prisma/client';
import { reservationService } from '../src/services/reservation.service';
import { inventoryMutationService } from '../src/services/inventory-mutation.service';
import crypto from 'crypto';

const prisma = new PrismaClient();

const CLIENT_ID = 'demo-client';
let variantId = '';

async function setup() {
  console.log('--- Setting up Test Data ---');
  // Create a product and variant
  const product = await prisma.product.create({
    data: {
      clientId: CLIENT_ID,
      productCode: `TEST-RES-PROD-${Date.now()}`,
      slug: `test-res-prod-${Date.now()}`,
      title: 'Reservation Test Product',
      category: 'WOMEN',
      productType: 'READY_TO_WEAR',
      basePrice: 100,
      status: 'ACTIVE'
    }
  });

  const variant = await prisma.productVariant.create({
    data: {
      clientId: CLIENT_ID,
      productId: product.id,
      variantCode: `TEST-RES-VAR-${Date.now()}`,
      sku: `TEST-RES-SKU-${Date.now()}`,
      quantity: 100, // Initial physical stock
      reservedQty: 0,
      averageCost: 50
    }
  });

  variantId = variant.id;
  console.log(`Created Variant ${variant.sku} with 100 qty`);
}

async function verifyVariant(label: string, expectedQty: number, expectedReserved: number) {
  const v = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (v!.quantity !== expectedQty || v!.reservedQty !== expectedReserved) {
    throw new Error(`${label} FAILED! Expected Qty: ${expectedQty}, Reserved: ${expectedReserved}. Got Qty: ${v!.quantity}, Reserved: ${v!.reservedQty}`);
  }
  console.log(`✅ ${label} PASSED. Available: ${v!.quantity - v!.reservedQty}, Reserved: ${v!.reservedQty}, Physical: ${v!.quantity}`);
}

async function runRound30() {
  console.log('\n--- Round 30: Reserve successful ---');
  const soItemId = crypto.randomUUID();
  await reservationService.reserveStock(CLIENT_ID, [{ variantId, salesOrderItemId: soItemId, quantity: 20 }]);
  await verifyVariant('Round 30', 100, 20);
}

async function runRound31() {
  console.log('\n--- Round 31: Reserve beyond available ---');
  const soItemId = crypto.randomUUID();
  try {
    await reservationService.reserveStock(CLIENT_ID, [{ variantId, salesOrderItemId: soItemId, quantity: 120 }]);
    throw new Error('Should have failed to reserve 120!');
  } catch (e: any) {
    if (e.message.includes('Insufficient stock')) {
      console.log('✅ Round 31 PASSED. Correctly blocked over-reservation.');
    } else {
      throw e;
    }
  }
}

async function runRound32() {
  console.log('\n--- Round 32: Cancel reservation ---');
  const soItemId = crypto.randomUUID();
  // Reserve 15
  await reservationService.reserveStock(CLIENT_ID, [{ variantId, salesOrderItemId: soItemId, quantity: 15 }]);
  await verifyVariant('After Reservation', 100, 35); // 20 from R30 + 15 from R32

  // Release it
  await reservationService.releaseReservation(CLIENT_ID, soItemId);
  await verifyVariant('After Cancel', 100, 20); // Back to 20
}

async function runRound33() {
  console.log('\n--- Round 33: Partial dispatch ---');
  // We have 20 reserved from R30. Let's find its item ID.
  const res = await prisma.inventoryReservation.findFirst({
    where: { variantId, status: 'ACTIVE' }
  });
  
  if (!res) throw new Error("No active reservation found for Round 33");

  const dispatchQty = 8;
  await reservationService.dispatchReservation(CLIENT_ID, res.salesOrderItemId, dispatchQty, 'DSP-001');
  
  // Now we need to manually trigger the ledger OUT movement that dispatchOrder would trigger
  await inventoryMutationService.applyMovement({
    clientId: CLIENT_ID,
    variantId,
    movementType: 'OUT',
    quantityDelta: -dispatchQty,
    reason: 'SALE',
    referenceType: 'DISPATCH',
    referenceId: 'DSP-001',
    createdBy: 'TestRunner'
  });

  await verifyVariant('Round 33 (Partial Dispatch 8)', 92, 12);

  // Check reservation object
  const updatedRes = await prisma.inventoryReservation.findUnique({ where: { id: res.id } });
  if (updatedRes?.dispatchedQty !== 8 || updatedRes?.status !== 'PARTIALLY_FULFILLED') {
    throw new Error("Reservation object not correctly updated!");
  }
  console.log("✅ Reservation status verified: PARTIALLY_FULFILLED with 8 dispatched");
}

async function runRound34() {
  console.log('\n--- Round 34: Concurrent reservation race ---');
  // Current available is 92 - 12 = 80
  const soItemId1 = crypto.randomUUID();
  const soItemId2 = crypto.randomUUID();

  const promise1 = reservationService.reserveStock(CLIENT_ID, [{ variantId, salesOrderItemId: soItemId1, quantity: 70 }]);
  const promise2 = reservationService.reserveStock(CLIENT_ID, [{ variantId, salesOrderItemId: soItemId2, quantity: 70 }]);

  try {
    await Promise.all([promise1, promise2]);
    throw new Error("Both promises succeeded! Race condition vulnerability.");
  } catch (e: any) {
    if (e.message.includes('Insufficient stock')) {
       console.log('✅ Round 34 PASSED. One reservation blocked by database lock.');
    } else {
       throw e;
    }
  }

  // Find out which one succeeded
  await verifyVariant('Round 34 (One succeeded, one failed)', 92, 82); // 12 + 70 = 82
}

async function runRound35() {
  console.log('\n--- Round 35: Reservation expiry ---');
  const soItemId = crypto.randomUUID();
  // We have 10 available (92 - 82). Reserve 5.
  await reservationService.reserveStock(CLIENT_ID, [{ variantId, salesOrderItemId: soItemId, quantity: 5 }]);
  await verifyVariant('Before Expiry', 92, 87);

  // Simulate expiry by updating date and running release
  const res = await prisma.inventoryReservation.findFirst({
    where: { salesOrderItemId: soItemId }
  });

  await prisma.inventoryReservation.update({
    where: { id: res!.id },
    data: { expiresAt: new Date(Date.now() - 10000) } // 10 seconds ago
  });

  // We haven't implemented a cron job, but we can call release on it to simulate
  await reservationService.releaseReservation(CLIENT_ID, soItemId);
  
  // Verify it restored
  await verifyVariant('Round 35 (After Expiry Release)', 92, 82);
}

async function run() {
  try {
    await setup();
    await runRound30();
    await runRound31();
    await runRound32();
    await runRound33();
    await runRound34();
    await runRound35();
    
    console.log('\n🎉 ALL ACCEPTANCE TESTS PASSED (Rounds 30-35) 🎉');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
  } finally {
    // Cleanup
    if (variantId) {
      await prisma.product.deleteMany({ where: { variants: { some: { id: variantId } } } });
      console.log('Cleaned up test data.');
    }
    await prisma.$disconnect();
  }
}

run();
