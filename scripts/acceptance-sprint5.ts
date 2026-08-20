import { prisma } from '../src/lib/prisma';
import { returnService } from '../src/services/return.service';

async function runAcceptanceTests() {
  const clientId = 'test-client';
  console.log("=== Starting Sprint 5 Acceptance Tests (Returns) ===");

  try {
    // Setup data
    const timestamp = Date.now();
    const customer = await prisma.customer.create({
      data: { clientId, customerCode: `CUS-TEST-${timestamp}`, name: 'Test Customer', email: 'test@example.com' }
    });

    const product = await prisma.product.create({
      data: { clientId, title: 'Return Product', productCode: `PRD-RET-${timestamp}`, status: 'ACTIVE', slug: `return-product-${timestamp}`, category: 'UNISEX', productType: 'READY_TO_WEAR', basePrice: 20 }
    });

    const variant = await prisma.productVariant.create({
      data: { clientId, productId: product.id, sku: `SKU-RET-${timestamp}`, variantCode: `VAR-RET-${timestamp}`, quantity: 100, averageCost: 10, sellingPrice: 20 }
    });

    const order = await prisma.salesOrder.create({
      data: {
        clientId,
        customerId: customer.id,
        orderNumber: `SO-TEST-${timestamp}`,
        status: 'DISPATCHED',
        items: {
          create: [{ variantId: variant.id, quantity: 10, unitPrice: 20, unitCost: 10, totalPrice: 200, totalCost: 100, grossProfit: 100 }]
        }
      },
      include: { items: true }
    });

    const dispatch = await (prisma as any).dispatch.create({
      data: {
        clientId,
        salesOrderId: order.id,
        dispatchNumber: `DSP-TEST-${timestamp}`,
        status: 'SHIPPED',
        items: {
          create: [{ salesOrderItemId: order.items[0].id, quantity: 10, returnedQty: 0 }]
        }
      },
      include: { items: true }
    });

    const dispatchItemId = dispatch.items[0].id;
    console.log("Setup complete. Initial physical stock: 100");

    // ROUND 51: Return 2 items, disposition RESTOCK.
    console.log("\n--- Round 51: RESTOCK Return ---");
    const ret1 = await returnService.createReturn(clientId, order.id, [{ dispatchItemId, quantity: 2 }]);
    console.log(`Created return ${ret1.returnNumber} for 2 items`);
    await returnService.receiveReturn(clientId, ret1.id);
    await returnService.inspectReturn(clientId, ret1.id, [{ salesReturnItemId: ret1.items[0].id, disposition: 'RESTOCK' }]);
    await returnService.completeReturn(clientId, ret1.id);
    console.log(`Return ${ret1.returnNumber} completed.`);

    const v1 = await prisma.productVariant.findUnique({ where: { id: variant.id } });
    if (v1?.quantity !== 102) throw new Error(`Stock mismatch: Expected 102, got ${v1?.quantity}`);
    console.log("SUCCESS Round 51: Physical stock correctly increased by 2.");

    // ROUND 52: Reject excessive return
    console.log("\n--- Round 52: Duplicate/Excessive Return ---");
    try {
      await returnService.createReturn(clientId, order.id, [{ dispatchItemId, quantity: 9 }]);
      throw new Error("Should have failed!");
    } catch (e: any) {
      if (e.message.includes('Only 8 available')) {
        console.log("SUCCESS Round 52: Blocked excessive return correctly.");
      } else {
        throw e;
      }
    }

    // ROUND 53: Return 3 items DAMAGED.
    console.log("\n--- Round 53: DAMAGED Return ---");
    const ret3 = await returnService.createReturn(clientId, order.id, [{ dispatchItemId, quantity: 3 }]);
    await returnService.receiveReturn(clientId, ret3.id);
    await returnService.inspectReturn(clientId, ret3.id, [{ salesReturnItemId: ret3.items[0].id, disposition: 'DAMAGED' }]);
    await returnService.completeReturn(clientId, ret3.id);
    
    const v3 = await prisma.productVariant.findUnique({ where: { id: variant.id } });
    if (v3?.quantity !== 102) throw new Error(`Stock mismatch: Expected 102, got ${v3?.quantity}`);
    console.log("SUCCESS Round 53: Physical stock stayed at 102 for DAMAGED items.");

    // ROUND 54: Double complete terminal state
    console.log("\n--- Round 54: Terminal States ---");
    try {
      await returnService.completeReturn(clientId, ret3.id);
      throw new Error("Should have failed!");
    } catch (e: any) {
      if (e.message.includes('terminal state')) {
        console.log("SUCCESS Round 54: Blocked double completion.");
      } else {
        throw e;
      }
    }

    // ROUND 55: Partial return tracking
    console.log("\n--- Round 55: Partial Return State ---");
    const dItem = await (prisma as any).dispatchItem.findUnique({ where: { id: dispatchItemId } });
    if (dItem.returnedQty !== 5) throw new Error(`ReturnedQty mismatch: expected 5, got ${dItem.returnedQty}`);
    const available = dItem.quantity - dItem.returnedQty;
    if (available !== 5) throw new Error(`Available mismatch: expected 5, got ${available}`);
    console.log(`SUCCESS Round 55: Dispatch item returnedQty is ${dItem.returnedQty}. Available to return is ${available}.`);

    console.log("\n=== All Sprint 5 Acceptance Tests Passed ===");
  } catch (error) {
    console.error("Test failed:", error);
  }
}

runAcceptanceTests();
