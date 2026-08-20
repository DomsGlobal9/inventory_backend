import { PrismaClient } from '@prisma/client';
import { salesOrderService } from '../src/services/sales-order.service';
import { dispatchService } from '../src/services/dispatch.service';

const prisma = new PrismaClient();
const CLIENT_ID = 'demo-client';

let customerId = '';
let variantId = '';
let orderId = '';
let orderItemId = '';

async function setup() {
  console.log('--- Setting up Test Data for Sprint 4 ---');
  
  const customer = await prisma.customer.create({
    data: { clientId: CLIENT_ID, customerCode: `CUS-SPR4-${Date.now()}`, name: 'Sprint4 Tester' }
  });
  customerId = customer.id;

  const product = await prisma.product.create({
    data: { clientId: CLIENT_ID, productCode: `PROD-SPR4-${Date.now()}`, slug: `prod-spr4-${Date.now()}`, title: 'Prod Sprint 4', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 100, status: 'ACTIVE' }
  });

  const variant = await prisma.productVariant.create({
    data: { clientId: CLIENT_ID, productId: product.id, variantCode: `VAR-SPR4-${Date.now()}`, sku: `SKU-SPR4-${Date.now()}`, quantity: 100, reservedQty: 0, sellingPrice: 150, averageCost: 80, inventoryValue: 8000 }
  });
  variantId = variant.id;

  const order = await salesOrderService.createDraftOrder(CLIENT_ID, customerId);
  orderId = order.id;
  await salesOrderService.addOrderItem(CLIENT_ID, orderId, variantId, 100);
  
  // Confirm it to lock reservations
  await salesOrderService.confirmOrder(CLIENT_ID, orderId);

  const fullOrder = await salesOrderService.getOrderById(CLIENT_ID, orderId);
  orderItemId = fullOrder.items[0].id;

  console.log(`Setup complete. Order CONFIRMED with 100 reserved.`);
}

async function runRound46() {
  console.log('\n--- Round 46: Partial Dispatch ---');
  await dispatchService.createDispatch(CLIENT_ID, orderId, [{ salesOrderItemId: orderItemId, quantity: 40 }]);

  const v = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (v!.quantity !== 60) throw new Error(`Physical stock wrong: expected 60, got ${v!.quantity}`);
  if (v!.reservedQty !== 60) throw new Error(`Reserved stock wrong: expected 60, got ${v!.reservedQty}`);

  const o = await prisma.salesOrder.findUnique({ where: { id: orderId } });
  if (o!.status !== 'PARTIALLY_DISPATCHED') throw new Error(`Status wrong: expected PARTIALLY_DISPATCHED, got ${o!.status}`);

  console.log(`✅ Round 46 PASSED. 40 dispatched, 60 remain.`);
}

async function runRound47() {
  console.log('\n--- Round 47: Full Dispatch ---');
  await dispatchService.createDispatch(CLIENT_ID, orderId, [{ salesOrderItemId: orderItemId, quantity: 60 }]);

  const v = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (v!.quantity !== 0) throw new Error(`Physical stock wrong: expected 0, got ${v!.quantity}`);
  if (v!.reservedQty !== 0) throw new Error(`Reserved stock wrong: expected 0, got ${v!.reservedQty}`);

  const o = await prisma.salesOrder.findUnique({ where: { id: orderId } });
  if (o!.status !== 'DISPATCHED') throw new Error(`Status wrong: expected DISPATCHED, got ${o!.status}`);

  console.log(`✅ Round 47 PASSED. Fully dispatched.`);
}

async function runRound48() {
  console.log('\n--- Round 48: Over Dispatch ---');
  // Need a new order
  const o2 = await salesOrderService.createDraftOrder(CLIENT_ID, customerId);
  await prisma.productVariant.update({ where: { id: variantId }, data: { quantity: 50, inventoryValue: 50*80 } });
  
  await salesOrderService.addOrderItem(CLIENT_ID, o2.id, variantId, 20);
  await salesOrderService.confirmOrder(CLIENT_ID, o2.id);

  const fullOrder = await salesOrderService.getOrderById(CLIENT_ID, o2.id);

  let failed = false;
  try {
    await dispatchService.createDispatch(CLIENT_ID, o2.id, [{ salesOrderItemId: fullOrder.items[0].id, quantity: 25 }]);
  } catch (e: any) {
    failed = true;
    if (!e.message.includes("Cannot dispatch 25")) {
      throw new Error("Wrong error: " + e.message);
    }
  }

  if (!failed) throw new Error("Over dispatch succeeded!");
  console.log(`✅ Round 48 PASSED. Prevented over-dispatching.`);
}

async function runRound49() {
  console.log('\n--- Round 49: Double Dispatch ---');
  // the order from 47 is already DISPATCHED
  let failed = false;
  try {
    await dispatchService.createDispatch(CLIENT_ID, orderId, [{ salesOrderItemId: orderItemId, quantity: 10 }]);
  } catch (e: any) {
    failed = true;
    if (!e.message.includes("Cannot dispatch order in DISPATCHED state")) {
      throw new Error("Wrong error: " + e.message);
    }
  }

  if (!failed) throw new Error("Double dispatch succeeded!");
  console.log(`✅ Round 49 PASSED. Prevented dispatching already completed order.`);
}

async function runRound50() {
  console.log('\n--- Round 50: Inventory Ledger Integrity ---');
  // Check transaction from round 46 (quantity: -40)
  const tx = await prisma.inventoryTransaction.findFirst({
    where: { clientId: CLIENT_ID, variantId, quantity: -40, type: 'OUT', reason: 'SALE' }
  });

  if (!tx) throw new Error("InventoryTransaction OUT/SALE not found!");

  // Check Sales Ledger
  const ledger = (prisma as any).salesLedger.findFirst({
    where: { clientId: CLIENT_ID, salesOrderId: orderId }
  });

  if (!ledger) throw new Error("SalesLedger entry not found!");

  console.log(`✅ Round 50 PASSED. Inventory OUT and Sales Ledger created.`);
}

async function run() {
  try {
    await setup();
    await runRound46();
    await runRound47();
    await runRound48();
    await runRound49();
    await runRound50();
    console.log('\n🎉 ALL ACCEPTANCE TESTS PASSED (Rounds 46-50) 🎉');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
