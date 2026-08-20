import { PrismaClient } from '@prisma/client';
import { salesOrderService } from '../src/services/sales-order.service';

const prisma = new PrismaClient();

const CLIENT_ID = 'demo-client';
let customerId = '';
let variantId = '';
let orderId = '';

async function setup() {
  console.log('--- Setting up Test Data ---');
  
  const customer = await prisma.customer.create({
    data: {
      clientId: CLIENT_ID,
      customerCode: `CUS-TEST-${Date.now()}`,
      name: 'Test Customer'
    }
  });
  customerId = customer.id;

  const product = await prisma.product.create({
    data: {
      clientId: CLIENT_ID,
      productCode: `TEST-SO-PROD-${Date.now()}`,
      slug: `test-so-prod-${Date.now()}`,
      title: 'SO Test Product',
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
      variantCode: `TEST-SO-VAR-${Date.now()}`,
      sku: `TEST-SO-SKU-${Date.now()}`,
      quantity: 100,
      sellingPrice: 150,
      averageCost: 100
    }
  });

  variantId = variant.id;
  console.log(`Created Variant ${variant.sku} with Price 150, Cost 100`);
}

async function runRound36() {
  console.log('\n--- Round 36: Create Draft Order ---');
  const order = await salesOrderService.createDraftOrder(CLIENT_ID, customerId);
  if (!order || order.status !== 'DRAFT') throw new Error("Order not created in DRAFT state");
  orderId = order.id;
  console.log(`✅ Round 36 PASSED. Created Order: ${order.orderNumber}`);
}

async function runRound37() {
  console.log('\n--- Round 37: Add multiple line items ---');
  await salesOrderService.addOrderItem(CLIENT_ID, orderId, variantId, 2); // 2 * 150 = 300
  await salesOrderService.addOrderItem(CLIENT_ID, orderId, variantId, 1); // 1 * 150 = 150
  
  const order = await salesOrderService.getOrderById(CLIENT_ID, orderId);
  if (Number(order.subtotal) !== 450 || Number(order.total) !== 450) {
    throw new Error(`Totals incorrect. Expected 450, Got ${order.subtotal}`);
  }
  
  const item = order.items[0];
  if (Number(item.totalCost) !== 200 || Number(item.grossProfit) !== 100) {
    throw new Error(`Item calculations incorrect. totalCost: ${item.totalCost}, grossProfit: ${item.grossProfit}`);
  }
  console.log(`✅ Round 37 PASSED. Totals and profits calculated correctly.`);
}

async function runRound38() {
  console.log('\n--- Round 38: Change variant selling price ---');
  await prisma.productVariant.update({
    where: { id: variantId },
    data: { sellingPrice: 200 }
  });
  
  const order = await salesOrderService.getOrderById(CLIENT_ID, orderId);
  const item = order.items[0];
  if (Number(item.unitPrice) !== 150) {
    throw new Error("Historical unitPrice changed!");
  }
  console.log(`✅ Round 38 PASSED. Existing order price remains unchanged (150).`);
}

async function runRound39() {
  console.log('\n--- Round 39: Change variant average cost ---');
  await prisma.productVariant.update({
    where: { id: variantId },
    data: { averageCost: 120 }
  });
  
  const order = await salesOrderService.getOrderById(CLIENT_ID, orderId);
  const item = order.items[0];
  if (Number(item.unitCost) !== 100) {
    throw new Error("Historical unitCost changed!");
  }
  console.log(`✅ Round 39 PASSED. Existing order cost remains unchanged (100).`);
}

async function runRound40() {
  console.log('\n--- Round 40: Delete draft order ---');
  
  // Note: variant qty before delete
  const vBefore = await prisma.productVariant.findUnique({ where: { id: variantId } });
  
  await salesOrderService.deleteOrder(CLIENT_ID, orderId);
  
  const vAfter = await prisma.productVariant.findUnique({ where: { id: variantId } });
  
  if (vBefore!.quantity !== vAfter!.quantity) {
    throw new Error("Inventory changed when draft order was deleted!");
  }
  
  console.log(`✅ Round 40 PASSED. Inventory remains unchanged.`);
}

async function run() {
  try {
    await setup();
    await runRound36();
    await runRound37();
    await runRound38();
    await runRound39();
    await runRound40();
    console.log('\n🎉 ALL ACCEPTANCE TESTS PASSED (Rounds 36-40) 🎉');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
  } finally {
    if (customerId) await prisma.customer.delete({ where: { id: customerId } });
    if (variantId) await prisma.product.deleteMany({ where: { variants: { some: { id: variantId } } } });
    if (orderId) await prisma.salesOrder.delete({ where: { id: orderId } });
    await prisma.$disconnect();
  }
}

run();
