import { PrismaClient } from '@prisma/client';
import assert from 'assert';

const API_URL = 'http://localhost:4006/api/v1';
const prisma = new PrismaClient();
const TENANT = 'acceptance-test-tenant';
const TENANT_B = 'tenant-b';

let productId: string;
let variantId: string;
let supplierId: string;
let poId: string;
let poItemId: string;
let auditId: string;
let auditItemId: string;

async function apiCall(endpoint: string, method: string = 'GET', body: any = null, clientId: string = TENANT) {
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_URL}${endpoint}`, options);
  
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Non-JSON response from ${method} ${endpoint}: ${res.status} ${text}`);
  }
  
  return { status: res.status, data: json };
}

async function cleanup() {
  console.log("🧹 Cleaning up test tenants...");
  const tenants = [TENANT, TENANT_B];
  await prisma.inventoryTransaction.deleteMany({ where: { clientId: { in: tenants } } });
  await prisma.stockCountItem.deleteMany({ where: { stockCount: { clientId: { in: tenants } } } });
  await prisma.stockCount.deleteMany({ where: { clientId: { in: tenants } } });
  await prisma.purchaseOrderItem.deleteMany({ where: { po: { clientId: { in: tenants } } } });
  await prisma.purchaseOrder.deleteMany({ where: { clientId: { in: tenants } } });
  await prisma.supplier.deleteMany({ where: { clientId: { in: tenants } } });
  await prisma.productImage.deleteMany({ where: { product: { clientId: { in: tenants } } } });
  await prisma.productVariant.deleteMany({ where: { clientId: { in: tenants } } });
  await prisma.product.deleteMany({ where: { clientId: { in: tenants } } });

  // Reset sequences to test tenant-scoped unique constraints
  await prisma.clientSequence.updateMany({
    where: { clientId: { in: tenants } },
    data: { lastValue: 0 }
  });
}

async function runRound1() {
  console.log("▶️ Round 1: Catalog Lifecycle");
  
  // Create Product
  let res = await apiCall('/products', 'POST', {
    title: 'Acceptance Test Shirt',
    category: 'UNISEX',
    productType: 'READY_TO_WEAR',
    basePrice: 50,
    status: 'ACTIVE'
  });
  assert(res.status === 201, `Failed to create product: ${JSON.stringify(res.data)}`);
  assert(res.data.data.productCode.startsWith('PRD-'), 'Product code format invalid');
  productId = res.data.data.id;

  // Create Variant
  res = await apiCall(`/products/${productId}/variants/bulk`, 'POST', {
    variants: [{
      sku: 'TEST-SHIRT-M',
      size: 'M',
      colorName: 'Red',
      quantity: 0,
      reorderLevel: 10
    }]
  });
  assert(res.status === 201, `Failed to create variants: ${JSON.stringify(res.data)}`);
  assert(res.data.data.created === 1, `Bulk create count mismatch: ${JSON.stringify(res.data)}`);

  // Fetch to get variantId
  res = await apiCall(`/products/${productId}/variants`);
  assert(res.status === 200);
  assert(res.data.data.length === 1);
  assert(res.data.data[0].variantCode.startsWith('VAR-'));
  variantId = res.data.data[0].id;
  
  // Test Image mocking (Assuming creating image record is sufficient)
  res = await apiCall(`/products/${productId}/images`, 'POST', {
    url: 'https://example.com/image.png',
    isPrimary: true
  });
  assert(res.status === 201, 'Failed to add image');
  
  console.log("✅ Round 1 Passed");
}

async function runRound2() {
  console.log("▶️ Round 2: Inventory Engine");
  
  // Stock In
  let res = await apiCall('/inventory/stock-in', 'POST', {
    variantId,
    quantity: 100,
    reference: 'INITIAL',
    notes: 'Init stock'
  });
  assert(res.status === 200);
  
  // Verify Stock
  const variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert(variant?.quantity === 100);

  // Stock Out
  res = await apiCall('/inventory/stock-out', 'POST', {
    variantId,
    quantity: 20,
    reference: 'SALE',
    notes: 'Sold'
  });
  assert(res.status === 200);
  
  const variantAfter = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert(variantAfter?.quantity === 80);

  // Negative Guard
  res = await apiCall('/inventory/stock-out', 'POST', {
    variantId,
    quantity: 9999,
    reference: 'SALE'
  });
  assert(res.status === 400 || res.status === 500, 'Negative stock should be rejected');
  
  console.log("✅ Round 2 Passed");
}

async function runRound3() {
  console.log("▶️ Round 3: Low Stock Engine");
  
  // Set quantity to 5
  await apiCall('/inventory/adjustment', 'POST', { variantId, quantity: 5 - 80, reference: 'SET_TO_5' });
  
  let res = await apiCall('/inventory/alerts');
  assert(res.data.data.lowStock.some((a: any) => a.id === variantId), 'Variant should be in lowStock');
  
  // Set quantity to 0
  await apiCall('/inventory/adjustment', 'POST', { variantId, quantity: -5, reference: 'SET_TO_0' });
  
  res = await apiCall('/inventory/alerts');
  assert(res.data.data.outOfStock.some((a: any) => a.id === variantId), 'Variant should be outOfStock');
  
  // Restore some stock for future tests
  await apiCall('/inventory/stock-in', 'POST', { variantId, quantity: 20 });
  
  console.log("✅ Round 3 Passed");
}

async function runRound4() {
  console.log("▶️ Round 4: Search Engine");
  
  const variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
  
  let res = await apiCall(`/search?q=${variant?.barcode}`);
  assert(res.data.data.variants.length > 0, 'Exact barcode search failed');

  res = await apiCall(`/search?q=${variant?.variantCode}`);
  assert(res.data.data.variants.length > 0, 'Exact variantCode search failed');

  res = await apiCall('/search?q=TEST-SHIRT-M');
  assert(res.data.data.variants.length > 0, 'SKU search failed');

  console.log("✅ Round 4 Passed");
}

async function runRound5() {
  console.log("▶️ Round 5: Purchase Order Workflow");
  
  // Create Supplier
  let res = await apiCall('/suppliers', 'POST', { name: 'Test Supplier' });
  assert(res.status === 201, `Failed to create supplier: ${JSON.stringify(res.data)}`);
  assert(res.data.data.supplierCode.startsWith('SUP-'));
  supplierId = res.data.data.id;

  // Create PO
  res = await apiCall('/purchase-orders', 'POST', {
    supplierId,
    items: [{ variantId, orderedQty: 10, unitPrice: 50 }]
  });
  assert(res.status === 201 || res.status === 200);
  assert(res.data.data.poNumber.startsWith('PO-'));
  poId = res.data.data.id;
  poItemId = res.data.data.items[0].id;
  
  // Verify Snapshots
  const item = res.data.data.items[0];
  assert(item.sku === 'TEST-SHIRT-M');
  assert(item.productTitle === 'Acceptance Test Shirt');

  // Change PO status to SENT
  await apiCall(`/purchase-orders/${poId}/status`, 'PUT', { status: 'SENT' });

  // Partial Receipt
  res = await apiCall(`/purchase-orders/${poId}/receive`, 'POST', {
    receipts: [{ poItemId, quantityReceived: 5 }]
  });
  assert(res.status === 200, `Failed to partial receive: ${JSON.stringify(res.data)}`);
  assert(res.data.data.status === 'PARTIALLY_RECEIVED');

  // Full Receipt
  res = await apiCall(`/purchase-orders/${poId}/receive`, 'POST', {
    receipts: [{ poItemId, quantityReceived: 5 }]
  });
  assert(res.data.data.status === 'RECEIVED');

  // Over Receipt Guard
  res = await apiCall(`/purchase-orders/${poId}/receive`, 'POST', {
    receipts: [{ poItemId, quantityReceived: 5 }]
  });
  assert(res.status === 400 || res.status === 500, 'Over-receipt should be blocked');

  console.log("✅ Round 5 Passed");
}

async function runRound6() {
  console.log("▶️ Round 6: Audit Module");
  
  let res = await apiCall('/stock-counts', 'POST', { name: 'Test Count' });
  assert(res.status === 201, `Failed to create stock count: ${JSON.stringify(res.data)}`);
  auditId = res.data.data.id;

  await apiCall(`/stock-counts/${auditId}/start`, 'POST');

  const countData = await apiCall(`/stock-counts/${auditId}`);
  auditItemId = countData.data.data.items.find((i: any) => i.variantId === variantId).id;
  const expectedQty = countData.data.data.items.find((i: any) => i.variantId === variantId).expectedQty;

  // Update Count
  await apiCall(`/stock-counts/${auditId}/items/${auditItemId}`, 'PUT', { countedQty: expectedQty - 2 });

  // Complete
  res = await apiCall(`/stock-counts/${auditId}/complete`, 'POST');
  assert(res.status === 200);
  assert(res.data.data.status === 'COMPLETED');

  // Double complete guard
  res = await apiCall(`/stock-counts/${auditId}/complete`, 'POST');
  assert(res.status === 400 || res.status === 500, 'Double complete should be blocked');

  console.log("✅ Round 6 Passed");
}

async function runRound7() {
  console.log("▶️ Round 7 & 12: Product Lifecycle");

  let res = await apiCall(`/products/${productId}/archive`, 'POST');
  assert(res.status === 200);
  let p: any = await prisma.product.findUnique({ where: { id: productId } });
  assert(p?.status === 'ARCHIVED');

  res = await apiCall(`/products/${productId}/trash`, 'POST');
  p = await prisma.product.findUnique({ where: { id: productId } });
  assert(p?.status === 'TRASHED');
  assert(p?.previousStatus === 'ARCHIVED');
  assert(p?.trashedAt !== null);

  res = await apiCall(`/products/${productId}/restore`, 'POST');
  p = await prisma.product.findUnique({ where: { id: productId } });
  assert(p?.status === 'ARCHIVED');

  console.log("✅ Round 7 & 12 Passed");
}

async function runRound8() {
  console.log("▶️ Round 8 & 13: Hard Delete Protection");

  // Attempt delete on product with history
  let res = await apiCall(`/products/${productId}/hard`, 'DELETE');
  assert(res.status === 400, 'Hard delete should be blocked for product with history');
  assert(res.data.message.includes('Cannot delete product'), 'Error message mismatch');

  // Create fresh clean product
  res = await apiCall('/products', 'POST', { 
    title: 'Clean Product', 
    status: 'TRASHED',
    category: 'UNISEX',
    productType: 'READY_TO_WEAR',
    basePrice: 50
  });
  assert(res.status === 201, `Failed to create clean product: ${JSON.stringify(res.data)}`);
  const cleanId = res.data.data.id;
  
  // Wait 7 days wait time logic exists, we can mock it by setting trashedAt in DB
  await prisma.product.update({ where: { id: cleanId }, data: { trashedAt: new Date(Date.now() - 10 * 86400000) } as any });

  res = await apiCall(`/products/${cleanId}/hard`, 'DELETE');
  assert(res.status === 200, 'Clean product should be deleted');
  
  const check = await prisma.product.findUnique({ where: { id: cleanId } });
  assert(check === null, 'Product was not deleted from DB');

  console.log("✅ Round 8 & 13 Passed");
}

async function runRound9() {
  console.log("▶️ Round 9: Database Integrity");
  
  // Ensure we didn't orphan anything in the test tenant
  const orphanTransactions: any = await prisma.$queryRaw`
    SELECT COUNT(*) FROM inventory_transactions
    WHERE client_id = ${TENANT} AND variant_id IS NULL
  `;
  assert(Number(orphanTransactions[0].count) === 0, 'Orphaned transactions found');

  const nullFkPos: any = await prisma.$queryRaw`
    SELECT COUNT(*) FROM purchase_order_items i
    JOIN purchase_orders po ON i.po_id = po.id
    WHERE po.client_id = ${TENANT} AND i.variant_id IS NULL
  `;
  assert(Number(nullFkPos[0].count) === 0, 'Null foreign keys in PO items');

  console.log("✅ Round 9 Passed");
}

async function runRound10() {
  console.log("▶️ Round 10: Ledger Validation");

  const transactions = await prisma.inventoryTransaction.findMany({ where: { variantId } });
  let deltaSum = 0;
  for (const t of transactions) {
    deltaSum += t.quantity;
  }

  const variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert(deltaSum === variant?.quantity, `Ledger sum ${deltaSum} !== Actual Stock ${variant?.quantity}`);

  console.log("✅ Round 10 Passed");
}

async function runRound11() {
  console.log("▶️ Round 11: Snapshot Integrity");

  // Update variant SKU
  await apiCall(`/variants/${variantId}`, 'PATCH', { sku: 'BLUE-SHIRT-M' });

  // Verify historical PO Item still has original SKU
  const item = await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } });
  assert(item?.sku === 'TEST-SHIRT-M', 'PO Item snapshot was mutated!');

  // Verify historical Audit still has original SKU
  const auditItem = await prisma.stockCountItem.findUnique({ where: { id: auditItemId } });
  assert(auditItem?.sku === 'TEST-SHIRT-M', 'Audit Item snapshot was mutated!');

  console.log("✅ Round 11 Passed");
}

async function runRound14() {
  console.log("▶️ Round 14: Multi-Tenant Security");

  // Try accessing TENANT's product using TENANT_B
  let res = await apiCall(`/products/${productId}`, 'GET', null, TENANT_B);
  assert(res.status === 404, 'Tenant B accessed Tenant A data');

  res = await apiCall('/purchase-orders', 'GET', null, TENANT_B);
  assert(res.data.data.length === 0, 'Tenant B sees Tenant A POs');

  console.log("✅ Round 14 Passed");
}

async function runRound15() {
  console.log("▶️ Round 15: Concurrency Test");

  // Create a new PO for concurrency
  let res = await apiCall('/purchase-orders', 'POST', {
    supplierId,
    items: [{ variantId, orderedQty: 50, unitPrice: 50 }]
  });
  const concPoId = res.data.data.id;
  const concPoItemId = res.data.data.items[0].id;

  await apiCall(`/purchase-orders/${concPoId}/status`, 'PUT', { status: 'SENT' });

  // Fire 5 concurrent requests to receive 10 items each
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(apiCall(`/purchase-orders/${concPoId}/receive`, 'POST', {
      receipts: [{ poItemId: concPoItemId, quantityReceived: 10 }]
    }));
  }

  const results = await Promise.allSettled(promises);
  
  // They should ideally all succeed since we use transactions and proper increments
  const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status !== 200));
  if (failed.length > 0) {
    console.log("Failed concurrent requests:", JSON.stringify(failed, null, 2));
  }
  
  const finalPo = await prisma.purchaseOrder.findUnique({ where: { id: concPoId }, include: { items: true } });
  
  assert(finalPo?.items[0].receivedQty === 50, `Concurrency failed. Received: ${finalPo?.items[0].receivedQty}`);
  assert(finalPo?.status === 'RECEIVED', 'Status should be completely received');

  console.log("✅ Round 15 Passed");
}

async function runRound16() {
  console.log("▶️ Round 16: Multi-Tenant Sequence Isolation");
  
  // Both tenants create a supplier
  const sA = await apiCall('/suppliers', 'POST', { name: 'Supplier A' }, TENANT);
  const sB = await apiCall('/suppliers', 'POST', { name: 'Supplier B' }, TENANT_B);
  
  assert(sA.status === 201 && sA.data.data.supplierCode === 'SUP-000002', `Tenant A expected SUP-000002 but got ${sA.data?.data?.supplierCode}`);
  assert(sB.status === 201 && sB.data.data.supplierCode === 'SUP-000001', `Tenant B expected SUP-000001 but got ${sB.data?.data?.supplierCode}`);

  console.log("✅ Round 16 Passed");
}

async function runRound17() {
  console.log("▶️ Round 17: Costing Engine (WAC Stability)");

  // 1. Create a product and variant
  const p1 = await apiCall('/products', 'POST', {
    title: 'WAC Test Product',
    category: 'UNISEX',
    productType: 'READY_TO_WEAR',
    basePrice: 100,
    status: 'ACTIVE'
  });
  const productId = p1.data.data.id;

  const createV = await apiCall(`/products/${productId}/variants/bulk`, 'POST', {
    variants: [{ sku: 'WAC-100', colorName: 'Black' }]
  });
  
  let v = await apiCall(`/products/${productId}/variants`, 'GET');
  if (!v.data.data || !v.data.data[0]) {
    console.error("Variant bulk create response:", JSON.stringify(createV.data));
    console.error("Variants GET response:", JSON.stringify(v.data));
  }
  const variantId = v.data.data[0].id;

  // 2. Initial Stock In 100 @ 50 (via manual stock in, or PO)
  // Our manual stock in might not take unitCost yet! Let's do it via PO to be safe since we know PO sets it.
  const supplierRes = await apiCall('/suppliers', 'POST', { name: 'WAC Supplier' });
  const supplierId = supplierRes.data.data.id;

  const po1 = await apiCall('/purchase-orders', 'POST', {
    supplierId,
    expectedDeliveryDate: new Date().toISOString(),
    items: [{ variantId, orderedQty: 100, unitPrice: 50 }]
  });
  const poId1 = po1.data.data.id;
  const poItemId1 = po1.data.data.items[0].id;
  await apiCall(`/purchase-orders/${poId1}/receive`, 'POST', { receipts: [{ poItemId: poItemId1, quantityReceived: 100 }] });

  v = await apiCall(`/products/${productId}/variants`, 'GET');
  assert(Number(v.data.data[0].averageCost) === 50, `Expected WAC 50, got ${v.data.data[0].averageCost}`);
  
  // 3. Receive 50 @ 60
  const po2 = await apiCall('/purchase-orders', 'POST', {
    supplierId,
    expectedDeliveryDate: new Date().toISOString(),
    items: [{ variantId, orderedQty: 50, unitPrice: 60 }]
  });
  const poId2 = po2.data.data.id;
  const poItemId2 = po2.data.data.items[0].id;
  await apiCall(`/purchase-orders/${poId2}/receive`, 'POST', { receipts: [{ poItemId: poItemId2, quantityReceived: 50 }] });

  v = await apiCall(`/products/${productId}/variants`, 'GET');
  const expectedWac = (100 * 50 + 50 * 60) / 150; // 53.3333
  // Prisma Decimal rounding:
  const actualWac = Number(v.data.data[0].averageCost);
  assert(Math.abs(actualWac - 53.33) < 0.05, `Expected WAC ~53.33, got ${actualWac}`);

  // 4. Stock Out 75
  await apiCall('/inventory/adjustment', 'POST', {
    variantId,
    quantity: -75,
    reason: 'SALE'
  });

  v = await apiCall(`/products/${productId}/variants`, 'GET');
  const wacAfterOut = Number(v.data.data[0].averageCost);
  assert(wacAfterOut === actualWac, `Expected WAC to remain ${actualWac} after stock out, got ${wacAfterOut}`);

  // 5. Receive 100 @ 80
  const po3 = await apiCall('/purchase-orders', 'POST', {
    supplierId,
    expectedDeliveryDate: new Date().toISOString(),
    items: [{ variantId, orderedQty: 100, unitPrice: 80 }]
  });
  const poId3 = po3.data.data.id;
  const poItemId3 = po3.data.data.items[0].id;
  await apiCall(`/purchase-orders/${poId3}/receive`, 'POST', { receipts: [{ poItemId: poItemId3, quantityReceived: 100 }] });

  v = await apiCall(`/products/${productId}/variants`, 'GET');
  const wacAfterThird = Number(v.data.data[0].averageCost);
  // Current qty = 150 - 75 = 75. WAC = actualWac (~53.33)
  // New qty = 100. Price = 80.
  // New WAC = (75 * actualWac + 100 * 80) / 175 = (4000 + 8000) / 175 = 68.57
  assert(wacAfterThird > actualWac && wacAfterThird < 80, `Expected WAC recalculated correctly, got ${wacAfterThird}`);

  console.log("✅ Round 17 Passed");
}

async function runRound22() {
  console.log("▶️ Round 22: Catalog Config Edit");
  
  // 1. Create a catalog item
  let res = await apiCall('/catalog/items', 'POST', {
    type: 'DRESS_TYPE',
    value: 'Sherwani',
    label: 'Sherwani',
    category: 'MEN'
  });
  assert(res.status === 201, `Failed to create catalog item: ${JSON.stringify(res.data)}`);
  const itemId = res.data.data.id;

  // 2. Update the item's category to WOMEN
  res = await apiCall(`/catalog/items/${itemId}`, 'PATCH', {
    category: 'WOMEN',
    value: 'Sherwani_Women'
  });
  assert(res.status === 200, `Failed to update catalog item: ${JSON.stringify(res.data)}`);
  assert(res.data.data.category === 'WOMEN', 'Category did not update');
  assert(res.data.data.value === 'Sherwani_Women', 'Value did not update');

  console.log("✅ Round 22 Passed");
}

async function runRound23() {
  console.log("\n▶️ Round 23: Catalog Config Deletion Safety");
  
  // 1. Create a catalog item
  let res = await apiCall('/catalog/items', 'POST', {
    type: 'DRESS_TYPE',
    value: 'Safe_Delete',
    label: 'Safe Delete',
    category: 'MEN'
  });
  const unusedId = res.data.data.id;

  // 2. Delete it (should succeed since unused)
  res = await apiCall(`/catalog/items/${unusedId}`, 'DELETE');
  assert(res.status === 200, `Expected unused item to be deleted, got ${res.status}`);

  // 3. Create another catalog item
  res = await apiCall('/catalog/items', 'POST', {
    type: 'DRESS_TYPE',
    value: 'Blocked_Delete',
    label: 'Blocked Delete',
    category: 'MEN'
  });
  const usedId = res.data.data.id;

  // 4. Create a product that references this item
  res = await apiCall('/products', 'POST', {
    title: 'Referencing Product',
    category: 'MEN',
    productType: 'READY_TO_WEAR',
    dressType: 'Blocked_Delete', // Reference the new item
    basePrice: 50,
    status: 'ACTIVE'
  });
  assert(res.status === 201, 'Failed to create product');

  // 5. Try to delete the used catalog item
  res = await apiCall(`/catalog/items/${usedId}`, 'DELETE');
  assert(res.status === 400, `Expected 400 when deleting used item, got ${res.status}`);
  assert(res.data.message.includes('Cannot delete'), 'Should return a clear error message');

  console.log("✅ Round 23 Passed");
}

async function runAll() {
  try {
    await cleanup();
    
    await runRound1();
    await runRound2();
    await runRound3();
    await runRound4();
    await runRound5();
    await runRound6();
    await runRound7();
    await runRound8();
    await runRound9();
    await runRound10();
    await runRound11();
    await runRound14();
    await runRound15();
    await runRound16();
    await runRound17();
    await runRound18();

    await runRound19();
    await runRound20();
    await runRound21();
    
    await runRound22();
    await runRound23();
    
    console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY");
  } catch (err) {
    console.error("❌ Test Failed:", err);
    process.exit(1);
  } finally {
    // await cleanup(); // Leave data for manual inspection if needed, or uncomment to wipe
    await prisma.$disconnect();
  }
}

async function runRound18() {
  console.log("\n▶️ Round 18: Valuation Service & Snapshots");
  
  // Create a snapshot
  let res = await apiCall('/reports/snapshots', 'POST');
  assert(res.status === 201, `Failed to create snapshot: ${JSON.stringify(res.data)}`);
  
  const snapshotId = res.data.data.id;
  assert(Number(res.data.data.totalValue) > 0, 'Total value should be > 0');
  
  // Check the tenant value endpoint
  res = await apiCall('/reports/inventory-value', 'GET');
  assert(res.status === 200);
  assert(Number(res.data.data.totalValue) > 0, 'Tenant total value should be > 0');

  // Check the category value endpoint
  res = await apiCall('/reports/category-value', 'GET');
  assert(res.status === 200);
  assert(res.data.data.length > 0, 'Should have category breakdown');
  assert(res.data.data[0].category === 'UNISEX', 'Category should be UNISEX');

  console.log("✅ Round 18 Passed");
}

async function runRound19() {
  console.log("\n▶️ Round 19: Tenant Sequence Isolation");

  // Create Product in Tenant A
  let resA = await apiCall('/products', 'POST', {
    title: 'Tenant A Product',
    category: 'UNISEX',
    productType: 'READY_TO_WEAR',
    basePrice: 50,
    status: 'ACTIVE'
  }, TENANT);
  
  // Create Product in Tenant B
  let resB = await apiCall('/products', 'POST', {
    title: 'Tenant B Product',
    category: 'UNISEX',
    productType: 'READY_TO_WEAR',
    basePrice: 50,
    status: 'ACTIVE'
  }, TENANT_B);

  // Both should start at PRD-000001 or similar (depending on fast forward)
  // Let's create variants to test variantCode isolation
  let varA = await apiCall(`/products/${resA.data.data.id}/variants/bulk`, 'POST', {
    variants: [{ sku: 'A-SKU', size: 'M' }]
  }, TENANT);
  assert(varA.status === 201);
  
  let varB = await apiCall(`/products/${resB.data.data.id}/variants/bulk`, 'POST', {
    variants: [{ sku: 'B-SKU', size: 'M' }]
  }, TENANT_B);
  assert(varB.status === 201);

  // Let's get the variant code of A
  let listA = await apiCall(`/products/${resA.data.data.id}/variants`, 'GET', null, TENANT);
  const codeA = listA.data.data[0].variantCode;

  // Let's search by this code in Tenant A
  let searchA = await apiCall(`/search?q=${codeA}`, 'GET', null, TENANT);
  assert(searchA.status === 200, `Search A failed: ${JSON.stringify(searchA)}`);
  assert(searchA.data.data.variants.length === 1, 'Tenant A should find its variant');

  // Let's search by this code in Tenant B (should be empty or return Tenant B's own if collision happens, but not Tenant A's)
  let searchB = await apiCall(`/search?q=${codeA}`, 'GET', null, TENANT_B);
  assert(searchB.status === 200, `Search B failed: ${JSON.stringify(searchB)}`);
  
  const bHasA = searchB.data.data.variants.find((v: any) => v.id === listA.data.data[0].id);
  assert(!bHasA, 'Tenant B should not find Tenant A variant by code');

  console.log("✅ Round 19 Passed");
}

async function runRound20() {
  console.log("\n▶️ Round 20: lastMovementAt Validation");

  // Create Product & Variant
  let res = await apiCall('/products', 'POST', {
    title: 'Movement Test Product',
    category: 'UNISEX',
    productType: 'READY_TO_WEAR',
    basePrice: 50,
    status: 'ACTIVE'
  });
  const prodId = res.data.data.id;

  res = await apiCall(`/products/${prodId}/variants/bulk`, 'POST', {
    variants: [{ sku: 'MOVE-TEST', size: 'M', quantity: 0 }]
  });
  
  res = await apiCall(`/products/${prodId}/variants`);
  const varId = res.data.data[0].id;
  let varData = res.data.data[0];
  
  assert(!varData.lastMovementAt, 'lastMovementAt should be null initially');

  // STOCK_IN
  res = await apiCall(`/inventory/stock-in`, 'POST', {
    variantId: varId,
    quantity: 10,
    reference: 'REF-IN'
  });
  
  res = await apiCall(`/products/${prodId}/variants`);
  varData = res.data.data[0];
  assert(varData.lastMovementAt !== null, 'lastMovementAt should be set after STOCK_IN');
  const t1 = new Date(varData.lastMovementAt).getTime();

  // STOCK_OUT (Wait a bit to ensure time changes)
  await new Promise(resolve => setTimeout(resolve, 1000));
  res = await apiCall(`/inventory/stock-out`, 'POST', {
    variantId: varId,
    quantity: 5,
    reference: 'REF-OUT'
  });

  res = await apiCall(`/products/${prodId}/variants`);
  varData = res.data.data[0];
  const t2 = new Date(varData.lastMovementAt).getTime();
  assert(t2 > t1, 'lastMovementAt should update after STOCK_OUT');

  console.log("✅ Round 20 Passed");
}

async function runRound21() {
  console.log("\n▶️ Round 21: Dead Stock Validation");

  // Create Product & Variant
  let res = await apiCall('/products', 'POST', {
    title: 'Dead Stock Product',
    category: 'UNISEX',
    productType: 'READY_TO_WEAR',
    basePrice: 50,
    status: 'ACTIVE'
  });
  const prodId = res.data.data.id;

  res = await apiCall(`/products/${prodId}/variants/bulk`, 'POST', {
    variants: [{ sku: 'DEAD-TEST', size: 'M', quantity: 0 }]
  });
  
  res = await apiCall(`/products/${prodId}/variants`);
  const varId = res.data.data[0].id;

  // Stock In to have quantity > 0
  await apiCall(`/inventory/stock-in`, 'POST', {
    variantId: varId,
    quantity: 100
  });

  // Force lastMovementAt to 120 days ago directly via Prisma (simulation)
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 120);
  await prisma.productVariant.update({
    where: { id: varId },
    data: { lastMovementAt: oldDate }
  });

  // Fetch Dead Stock Report
  res = await apiCall('/reports/dead-stock', 'GET');
  assert(res.status === 200);
  
  const deadItem = res.data.data.find((v: any) => v.id === varId);
  assert(deadItem, 'Variant should appear in dead stock report');
  assert(deadItem.daysSinceLastMovement >= 119, 'Days since last movement should be ~120');

  console.log("✅ Round 21 Passed");
}

runAll();
