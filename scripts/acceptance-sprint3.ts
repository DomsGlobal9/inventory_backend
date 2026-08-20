import { PrismaClient } from '@prisma/client';
import { salesOrderService } from '../src/services/sales-order.service';
import { reservationService } from '../src/services/reservation.service';

const prisma = new PrismaClient();
const CLIENT_ID = 'demo-client';

let customerId = '';
let productAId = '';
let variantAId = '';
let order1Id = '';
let order2Id = '';

async function setup() {
  console.log('--- Setting up Test Data for Sprint 3 ---');
  
  const customer = await prisma.customer.create({
    data: { clientId: CLIENT_ID, customerCode: `CUS-SPR3-${Date.now()}`, name: 'Sprint3 Tester' }
  });
  customerId = customer.id;

  const productA = await prisma.product.create({
    data: { clientId: CLIENT_ID, productCode: `PROD-A-${Date.now()}`, slug: `prod-a-${Date.now()}`, title: 'Prod A', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'ACTIVE' }
  });
  productAId = productA.id;

  const variantA = await prisma.productVariant.create({
    data: { clientId: CLIENT_ID, productId: productA.id, variantCode: `VAR-A-${Date.now()}`, sku: `SKU-A-${Date.now()}`, quantity: 50, reservedQty: 0, sellingPrice: 100, averageCost: 50 }
  });
  variantAId = variantA.id;

  console.log(`Created Variant A with Qty 50`);
}

async function runRound41() {
  console.log('\n--- Round 41: Confirm Draft Order ---');
  const order = await salesOrderService.createDraftOrder(CLIENT_ID, customerId);
  order1Id = order.id;
  await salesOrderService.addOrderItem(CLIENT_ID, order1Id, variantAId, 10);
  
  await salesOrderService.confirmOrder(CLIENT_ID, order1Id);
  
  const updatedOrder = await salesOrderService.getOrderById(CLIENT_ID, order1Id);
  if (updatedOrder.status !== 'CONFIRMED') throw new Error("Order status not updated to CONFIRMED");

  const v = await prisma.productVariant.findUnique({ where: { id: variantAId } });
  if (v!.reservedQty !== 10) throw new Error(`Reservation failed. Expected reservedQty 10, got ${v!.reservedQty}`);
  
  console.log(`✅ Round 41 PASSED. Order confirmed, 10 units reserved.`);
}

async function runRound42() {
  console.log('\n--- Round 42: Confirm Order With Insufficient Stock ---');
  const order2 = await salesOrderService.createDraftOrder(CLIENT_ID, customerId);
  order2Id = order2.id;
  
  // Try to order 100 units (only 40 available)
  await salesOrderService.addOrderItem(CLIENT_ID, order2Id, variantAId, 100);
  
  let failed = false;
  try {
    await salesOrderService.confirmOrder(CLIENT_ID, order2Id);
  } catch (e: any) {
    failed = true;
    if (!e.message.includes("Insufficient stock")) {
      throw new Error("Wrong error thrown: " + e.message);
    }
  }

  if (!failed) throw new Error("Order confirmed despite insufficient stock!");
  
  const o = await prisma.salesOrder.findUnique({ where: { id: order2Id } });
  if (o!.status !== 'DRAFT') throw new Error("Status changed to CONFIRMED despite rollback!");
  
  console.log(`✅ Round 42 PASSED. Insufficient stock prevented confirmation, status remains DRAFT.`);
}

async function runRound43() {
  console.log('\n--- Round 43: Cancel Confirmed Order ---');
  // We will cancel order1
  await salesOrderService.cancelOrder(CLIENT_ID, order1Id);
  
  const o = await prisma.salesOrder.findUnique({ where: { id: order1Id } });
  if (o!.status !== 'CANCELLED') throw new Error("Status not changed to CANCELLED");
  
  const v = await prisma.productVariant.findUnique({ where: { id: variantAId } });
  if (v!.reservedQty !== 0) throw new Error(`Reservation not released. Expected reservedQty 0, got ${v!.reservedQty}`);

  console.log(`✅ Round 43 PASSED. Order cancelled and reservations released.`);
}

async function runRound44() {
  console.log('\n--- Round 44: Confirm Same Order Twice ---');
  // Confirm order2 (we need to change its qty first because it has 100 right now)
  const o2 = await prisma.salesOrder.findUnique({ where: { id: order2Id }, include: { items: true } });
  await salesOrderService.removeOrderItem(CLIENT_ID, order2Id, o2!.items[0].id);
  await salesOrderService.addOrderItem(CLIENT_ID, order2Id, variantAId, 5); // valid amount
  
  await salesOrderService.confirmOrder(CLIENT_ID, order2Id);
  
  let failed = false;
  try {
    await salesOrderService.confirmOrder(CLIENT_ID, order2Id);
  } catch (e: any) {
    failed = true;
    if (!e.message.includes("Invalid state transition")) {
      throw new Error("State machine didn't catch it: " + e.message);
    }
  }
  
  if (!failed) throw new Error("Confirmed twice without error!");
  console.log(`✅ Round 44 PASSED. State machine prevented double confirmation.`);
}

async function runRound45() {
  console.log('\n--- Round 45: Cancel Already Cancelled Order ---');
  let failed = false;
  try {
    await salesOrderService.cancelOrder(CLIENT_ID, order1Id);
  } catch (e: any) {
    failed = true;
    if (!e.message.includes("Invalid state transition")) {
      throw new Error("State machine didn't catch it: " + e.message);
    }
  }
  
  if (!failed) throw new Error("Cancelled twice without error!");
  console.log(`✅ Round 45 PASSED. State machine prevented double cancellation.`);
}

async function run() {
  try {
    await setup();
    await runRound41();
    await runRound42();
    await runRound43();
    await runRound44();
    await runRound45();
    console.log('\n🎉 ALL ACCEPTANCE TESTS PASSED (Rounds 41-45) 🎉');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
  } finally {
    if (order1Id) await prisma.salesOrder.deleteMany({ where: { id: { in: [order1Id, order2Id] } } });
    if (customerId) await prisma.customer.delete({ where: { id: customerId } });
    if (productAId) await prisma.product.deleteMany({ where: { id: productAId } });
    await prisma.$disconnect();
  }
}

run();
