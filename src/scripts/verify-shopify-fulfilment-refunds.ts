/**
 * Goods leaving and money coming back, when Shopify is the one doing both.
 *
 * This is where a Shopify sale becomes revenue. Everything here is about two properties:
 *
 *   ABSOLUTE, NOT DELTA   Shopify says how much of a line has shipped IN TOTAL, and we move the
 *                         difference. A redelivered webhook computes zero and does nothing, which
 *                         is what makes Shopify's habit of sending things twice harmless.
 *   NET, NEVER LIST       a saree bought at 9,600 earns 9,600 and refunds 9,600 -- never the
 *                         12,000 it is listed at.
 *
 * Throwaway tenant, deleted at the end.
 *
 *   npx tsx src/scripts/verify-shopify-fulfilment-refunds.ts
 */
import { prisma } from '../lib/prisma';
import {
  shopifyOrderIngestService, shopifyFulfilmentService, shopifyRefundService
} from '../services/shopify-orders';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const STAMP = Date.now();
const CLIENT = `shopfulfil-${STAMP}`;
const SHOP = `fulfil-${STAMP}.myshopify.com`;
const num = (v: any) => Number(v);
const money = (v: any) => Math.round(Number(v) * 100);

let locationId = '';
let installationId = '';
const variantIds: Record<string, string> = {};
const SV = { saree: '9101', blouse: '9102' };

let nextId = 20000;
const order = (over: any = {}) => ({
  id: ++nextId, currency: 'INR', updated_at: '2026-09-12T10:00:00Z',
  financial_status: 'paid', fulfillment_status: null,
  total_tax: '0.00', total_discounts: '0.00', total_price: '36000.00',
  line_items: [{ variant_id: Number(SV.saree), quantity: 3, price: '12000.00', discount_allocations: [] }],
  discount_applications: [],
  customer: { id: 8001, first_name: 'Test', last_name: 'Buyer', email: `f${STAMP}@example.com` },
  ...over
});

const fulfilled = (o: any, lines: { variant: string; qty: number }[], status = 'success') => ({
  ...o,
  fulfillment_status: 'fulfilled',
  fulfillments: [{
    id: 500 + lines.length, status,
    line_items: lines.map(l => ({ variant_id: Number(l.variant), quantity: l.qty }))
  }]
});

const stockOf = (variantId: string) =>
  prisma.inventoryStock.findFirstOrThrow({ where: { variantId, locationId }, select: { quantity: true, reservedQty: true } });

const ledgerTotal = async (salesOrderId: string) =>
  (await prisma.salesLedger.findMany({ where: { salesOrderId } }))
    .reduce((s, l) => s + money(l.revenue), 0);

async function main() {
  // ── SETUP ──────────────────────────────────────────────────────────────
  const loc = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true }
  });
  locationId = loc.id;

  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-FUL', title: 'Kanchipuram Silk Saree',
      slug: `ful-${STAMP}`, category: 'WOMEN', basePrice: 12000, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });

  for (const [key, price, cost] of [['saree', 12000, 7000], ['blouse', 800, 300]] as const) {
    const v = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: `SKU-${key}-${STAMP}`,
        variantCode: `VAR-${key}-${STAMP}`, size: 'Free Size', colorName: 'Red',
        sellingPrice: price, averageCost: cost
      }
    });
    variantIds[key] = v.id;
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: v.id, locationId, quantity: 100, reservedQty: 0 }
    });
  }

  const inst = await prisma.shopifyInstallation.create({
    data: { shopDomain: SHOP, clientId: CLIENT, source: 'SCALEEZY',
            accessTokenEncrypted: 'x', scopes: 'read_orders' }
  });
  installationId = inst.id;

  await prisma.shopifyLocationMap.create({
    data: { installationId, clientId: CLIENT, locationId, shopifyLocationId: '6600' }
  });
  for (const key of ['saree', 'blouse'] as const) {
    await prisma.shopifyIdMap.create({
      data: { installationId, clientId: CLIENT, variantId: variantIds[key], sku: `SKU-${key}-${STAMP}`,
              shopifyProductId: '5000', shopifyVariantId: SV[key], origin: 'CREATED' }
    });
  }

  // ── A. SHIPPED IN PARTS ────────────────────────────────────────────────
  console.log('\nA. SHIPPED IN PARTS');

  // 3 sarees at 12,000 with 2,400 off the line -- 33,600 net, which does not divide by three.
  const base = order({
    total_discounts: '2400.00', total_price: '33600.00',
    line_items: [{
      variant_id: Number(SV.saree), quantity: 3, price: '12000.00',
      discount_allocations: [{ amount: '2400.00', discount_application_index: 0 }]
    }],
    discount_applications: [{ title: 'Deepavali Sale' }]
  });
  const ing: any = await shopifyOrderIngestService.ingest(SHOP, base, 'orders/create');
  check('the order is ingested and confirmed', ing.status === 'APPLIED', JSON.stringify(ing));

  const before = await stockOf(variantIds.saree);
  check('three units are reserved, none shipped', before.reservedQty === 3 && before.quantity === 100,
    JSON.stringify(before));

  const one = await shopifyFulfilmentService.apply(SHOP, fulfilled(base, [{ variant: SV.saree, qty: 1 }]));
  check('shipping one unit is applied', one === 'APPLIED', one);

  let o = await prisma.salesOrder.findUniqueOrThrow({ where: { id: ing.salesOrderId }, include: { items: true } });
  check('the order is partly shipped', o.status === 'PARTIALLY_DISPATCHED', o.status);
  check('  ...one unit, on the line', o.items[0].fulfilledQty === 1, String(o.items[0].fulfilledQty));

  const afterOne = await stockOf(variantIds.saree);
  check('stock fell by one', afterOne.quantity === 99, String(afterOne.quantity));
  check('  ...and the reservation shrank with it', afterOne.reservedQty === 2, String(afterOne.reservedQty));

  // ── B. THE SAME WEBHOOK AGAIN ──────────────────────────────────────────
  console.log('\nB. THE SAME FULFILMENT, DELIVERED AGAIN');

  const echo = await shopifyFulfilmentService.apply(SHOP, fulfilled(base, [{ variant: SV.saree, qty: 1 }]));
  check('a redelivery is recognised as our own voice coming back', echo === 'ECHO', echo);

  const afterEcho = await stockOf(variantIds.saree);
  check('  ...and moves no stock', afterEcho.quantity === 99, String(afterEcho.quantity));
  const dispatchCount = await prisma.dispatch.count({ where: { salesOrderId: ing.salesOrderId } });
  check('  ...and makes no second shipment', dispatchCount === 1, String(dispatchCount));

  // ── C. THE REST, AND THE MONEY ─────────────────────────────────────────
  console.log('\nC. THE REST, AND THE MONEY');

  // Shopify reports the TOTAL now shipped, not the increment -- three, not two.
  const rest = await shopifyFulfilmentService.apply(SHOP, fulfilled(base, [{ variant: SV.saree, qty: 3 }]));
  check('reporting three shipped ships the remaining two', rest === 'APPLIED', rest);

  o = await prisma.salesOrder.findUniqueOrThrow({ where: { id: ing.salesOrderId }, include: { items: true } });
  check('the order is fully shipped', o.status === 'DISPATCHED', o.status);
  check('  ...all three units', o.items[0].fulfilledQty === 3, String(o.items[0].fulfilledQty));

  const finalStock = await stockOf(variantIds.saree);
  check('stock is down by three in total', finalStock.quantity === 97, String(finalStock.quantity));
  check('nothing is left reserved', finalStock.reservedQty === 0, String(finalStock.reservedQty));

  const revenue = await ledgerTotal(ing.salesOrderId);
  check('REVENUE IS THE DISCOUNTED TOTAL, TO THE PAISA',
    revenue === 3360000, `${revenue / 100} recognised, expected 33600 (list would be 36000)`);
  check('  ...and it matches the order', revenue === money(o.total), `${revenue} vs ${money(o.total)}`);

  // ── D. WHAT IT WILL NOT DO ─────────────────────────────────────────────
  console.log('\nD. WHAT IT WILL NOT DO');

  const cancelledFul = order({ id: 21000 });
  const ing2: any = await shopifyOrderIngestService.ingest(SHOP, cancelledFul, 'orders/create');
  const ignored = await shopifyFulfilmentService.apply(
    SHOP, fulfilled(cancelledFul, [{ variant: SV.saree, qty: 1 }], 'cancelled')
  );
  check('a CANCELLED fulfilment ships nothing', ignored === 'IGNORED', ignored);
  const untouched = await prisma.salesOrder.findUniqueOrThrow({ where: { id: ing2.salesOrderId } });
  check('  ...and the order stays confirmed', untouched.status === 'CONFIRMED', untouched.status);

  const over = await shopifyFulfilmentService.apply(
    SHOP, fulfilled(cancelledFul, [{ variant: SV.saree, qty: 99 }])
  );
  check('shipping more than was ordered ships only what was ordered', over === 'APPLIED', over);
  const capped = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: ing2.salesOrderId }, include: { items: true }
  });
  check('  ...capped at the line', capped.items[0].fulfilledQty === 3, String(capped.items[0].fulfilledQty));

  check('a fulfilment for an order we do not have is harmless',
    (await shopifyFulfilmentService.apply(SHOP, fulfilled(order({ id: 999999 }), [{ variant: SV.saree, qty: 1 }]))) === 'IGNORED');

  // ── E. MONEY BACK ──────────────────────────────────────────────────────
  console.log('\nE. MONEY BACK');

  const beforeRefund = await stockOf(variantIds.saree);

  const refund = {
    id: 77001, order_id: base.id,
    refund_line_items: [{
      quantity: 1, subtotal: '11200.00', restock_type: 'return',
      line_item: { variant_id: Number(SV.saree) }
    }]
  };
  const refunded = await shopifyRefundService.apply(SHOP, refund);
  check('a Shopify refund is recorded', refunded === 'APPLIED', refunded);

  const ret = await prisma.salesReturn.findFirstOrThrow({
    where: { clientId: CLIENT, externalRefundId: '77001' }, include: { items: true }
  });
  check('  ...as a completed return, not a queue item', ret.status === 'COMPLETED', ret.status);
  check('  ...already paid, because Shopify paid it', ret.refundStatus === 'REFUNDED', ret.refundStatus);
  check('THE REFUND IS THE NET PRICE, NOT THE LIST',
    money(ret.refundTotal) === 1120000, `${ret.refundTotal} (list would be 12000)`);
  check('  ...and it is on the line too', money(ret.items[0].refundAmount) === 1120000,
    String(ret.items[0].refundAmount));
  check('  ...linked straight back to the order line it came off',
    ret.items[0].salesOrderItemId === o.items[0].id, String(ret.items[0].salesOrderItemId));

  const afterRefund = await stockOf(variantIds.saree);
  check('a restocked refund puts the unit back on the shelf',
    afterRefund.quantity === beforeRefund.quantity + 1,
    `${beforeRefund.quantity} -> ${afterRefund.quantity}`);

  const dup = await shopifyRefundService.apply(SHOP, refund);
  check('the same refund twice is refused', dup === 'DUPLICATE', dup);
  const afterDup = await stockOf(variantIds.saree);
  check('  ...so the unit is not restocked twice', afterDup.quantity === afterRefund.quantity,
    `${afterRefund.quantity} -> ${afterDup.quantity}`);

  // ── F. A REFUND THAT DOES NOT COME BACK ────────────────────────────────
  console.log('\nF. A REFUND WHERE THE CUSTOMER KEEPS THE GOODS');

  const keepIt = {
    id: 77002, order_id: base.id,
    refund_line_items: [{
      quantity: 1, subtotal: '11200.00', restock_type: 'no_restock',
      line_item: { variant_id: Number(SV.saree) }
    }]
  };
  const beforeKeep = await stockOf(variantIds.saree);
  check('it is recorded', (await shopifyRefundService.apply(SHOP, keepIt)) === 'APPLIED');

  const keptRet = await prisma.salesReturn.findFirstOrThrow({
    where: { clientId: CLIENT, externalRefundId: '77002' }, include: { items: true }
  });
  check('  ...the money is recorded', money(keptRet.refundTotal) === 1120000, String(keptRet.refundTotal));
  check('  ...marked as not coming back to the shelf', keptRet.items[0].disposition === 'SCRAP',
    keptRet.items[0].disposition);

  const afterKeep = await stockOf(variantIds.saree);
  check('  ...and NO stock moved', afterKeep.quantity === beforeKeep.quantity,
    `${beforeKeep.quantity} -> ${afterKeep.quantity}`);

  // ── G. REFUNDS WITH NOTHING TO RETURN ──────────────────────────────────
  console.log('\nG. REFUNDS WITH NOTHING TO RETURN');

  check('a shipping-only refund returns no goods',
    (await shopifyRefundService.apply(SHOP, { id: 77003, order_id: base.id, refund_line_items: [] })) === 'IGNORED');

  const unshipped = order({ id: 22000 });
  await shopifyOrderIngestService.ingest(SHOP, unshipped, 'orders/create');
  check('refunding an order that never shipped is left to the cancellation',
    (await shopifyRefundService.apply(SHOP, {
      id: 77004, order_id: 22000,
      refund_line_items: [{ quantity: 1, subtotal: '100.00', restock_type: 'return', line_item: { variant_id: Number(SV.saree) } }]
    })) === 'IGNORED');

  check('a refund for an order we do not have is harmless',
    (await shopifyRefundService.apply(SHOP, { id: 77005, order_id: 999999, refund_line_items: [] })) === 'IGNORED');

  // ── H. IT ALL ADDS UP ──────────────────────────────────────────────────
  console.log('\nH. IT ALL ADDS UP');

  const ledger = await prisma.salesLedger.findMany({ where: { clientId: CLIENT } });
  const recognised = ledger.reduce((s, l) => s + money(l.revenue), 0);
  const orders = await prisma.salesOrder.findMany({
    where: { clientId: CLIENT }, include: { items: true }
  });
  const shippedValue = orders.reduce((s, ord) =>
    s + ord.items.reduce((t, i) =>
      t + Math.round((money(i.totalPrice) * i.fulfilledQty) / i.quantity), 0), 0);

  check('revenue recognised equals the value of what actually left',
    Math.abs(recognised - shippedValue) <= orders.length,
    `${recognised / 100} recognised vs ${shippedValue / 100} shipped`);

  const negative = await prisma.inventoryStock.count({
    where: { clientId: CLIENT, OR: [{ quantity: { lt: 0 } }, { reservedQty: { lt: 0 } }] }
  });
  check('no stock figure went negative anywhere', negative === 0, String(negative));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.salesReturnItem.deleteMany({ where: { salesReturn: { clientId: CLIENT } } });
    await prisma.salesReturn.deleteMany({ where: { clientId: CLIENT } });
    await prisma.salesLedger.deleteMany({ where: { clientId: CLIENT } });
    await prisma.dispatchItem.deleteMany({ where: { dispatch: { clientId: CLIENT } } });
    await prisma.dispatch.deleteMany({ where: { clientId: CLIENT } });
    await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrder: { clientId: CLIENT } } } });
    await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.inventoryReservation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } });
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.salesOrder.deleteMany({ where: { clientId: CLIENT } });
    await prisma.customer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyOrderInbox.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.shopifyIdMap.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyLocationMap.deleteMany({ where: { clientId: CLIENT } });
    await prisma.shopifyInstallation.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
