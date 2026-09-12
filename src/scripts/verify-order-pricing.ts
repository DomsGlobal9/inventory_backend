/**
 * Phase 0: the price a customer actually paid, recorded as the price they actually paid.
 *
 * Until this release `createFullOrder` accepted `item.unitPrice` from the selling system and
 * then threw it away, re-pricing every line from our own catalogue. A saree sold online at
 * ₹9,600 after ₹2,400 off was filed as a ₹12,000 sale, and `grossProfit` -- plus the day book's
 * revenue and dispatch's valuation, both of which multiply `unitPrice` -- with it.
 *
 * Two halves:
 *
 *   A-C  the money primitives on their own. No database. These are where the paise go missing.
 *   D-J  whole orders through the real service, in a throwaway tenant deleted at the end, so
 *        this can be run against the live database without touching a real shop.
 *
 *   npx tsx src/scripts/verify-order-pricing.ts
 */
import { prisma } from '../lib/prisma';
import { salesOrderService } from '../services/sales-order.service';
import { dispatchService } from '../services/dispatch.service';
import { toMinor, fromMinor, applyPercent, allocate, netUnitPrice } from '../services/pricing';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `pricing-${Date.now()}`;
const num = (v: any) => Number(v);

/** Runs `fn` and reports whether it was refused with the status and wording expected. */
async function refuses(name: string, fragment: string, fn: () => Promise<any>) {
  try {
    await fn();
    check(name, false, 'it was accepted');
  } catch (error: any) {
    const message = String(error?.message ?? error);
    const is400 = error?.statusCode === 400;
    check(
      name,
      is400 && message.toLowerCase().includes(fragment.toLowerCase()),
      `status=${error?.statusCode} message="${message}"`
    );
  }
}

let locationId = '';
let customerId = '';
const variants: Record<string, string> = {};

/** One order, priced by the real service. Returns the order with its items, freshly read. */
async function placeOrder(items: any[], orderFields: any = {}) {
  const order = await salesOrderService.createFullOrder(
    CLIENT,
    locationId,
    { customer: { id: customerId }, items, ...orderFields },
    'ONLINE'
  );
  return readOrder(order.id);
}

async function readOrder(id: string) {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id },
    include: { items: { orderBy: { createdAt: 'asc' } } }
  });
  return order;
}

async function main() {
  // ── A. RUPEES TO PAISE AND BACK ────────────────────────────────────────
  console.log('\nA. RUPEES TO PAISE AND BACK');

  check('12500.00 -> 1250000 paise', toMinor(12500) === 1250000, String(toMinor(12500)));
  check('a price with paise survives', toMinor(12.34) === 1234, String(toMinor(12.34)));
  check('the classic float case 0.1+0.2', toMinor(0.1) + toMinor(0.2) === toMinor(0.3));
  check('null is zero, not NaN', toMinor(null) === 0);
  check('a Prisma Decimal is exact', toMinor(fromMinor(1234567)) === 1234567);
  check('round trip through the column type', num(fromMinor(999999)) === 9999.99);

  // ── B. PERCENTAGES, ROUNDED HALF-UP ────────────────────────────────────
  console.log('\nB. PERCENTAGES, ROUNDED HALF-UP');

  check('20% of 12000.00', applyPercent(1200000, 20) === 240000, String(applyPercent(1200000, 20)));
  check('a fractional percentage', applyPercent(100000, 12.5) === 12500, String(applyPercent(100000, 12.5)));
  check('exactly half a paisa rounds UP', applyPercent(1, 50) === 1, String(applyPercent(1, 50)));
  check('just under half rounds down', applyPercent(1, 49) === 0, String(applyPercent(1, 49)));
  // The float form of this -- (minor * basis) / 10000 then Math.round -- lands on
  // 1234.4999999999998 and rounds DOWN. The integer form cannot.
  check('the float-boundary case', applyPercent(2468999, 5) === 123450, String(applyPercent(2468999, 5)));

  // ── C. SPLITTING AN AMOUNT SO IT ADDS UP ───────────────────────────────
  console.log('\nC. SPLITTING AN AMOUNT SO IT ADDS UP');

  const three = allocate(10000, [10000, 10000, 10000]);
  check('₹100 across three equal lines sums to exactly ₹100',
    three.reduce((a, b) => a + b, 0) === 10000, JSON.stringify(three));
  check('  ...and the odd paise go to the earliest lines',
    JSON.stringify(three) === JSON.stringify([3334, 3333, 3333]), JSON.stringify(three));

  const weighted = allocate(50000, [1200000, 80000, 450000]);
  check('a weighted split still sums exactly',
    weighted.reduce((a, b) => a + b, 0) === 50000, JSON.stringify(weighted));

  check('the same input always gives the same output',
    JSON.stringify(allocate(50000, [1200000, 80000, 450000])) === JSON.stringify(weighted));

  const zeroWeights = allocate(1000, [0, 0, 0]);
  check('an all-zero basket still spreads the whole amount',
    zeroWeights.reduce((a, b) => a + b, 0) === 1000, JSON.stringify(zeroWeights));

  check('nothing to split is nothing allocated',
    JSON.stringify(allocate(0, [100, 200])) === JSON.stringify([0, 0]));
  check('no lines at all does not throw', JSON.stringify(allocate(500, [])) === '[]');

  check('net unit price of an uneven line rounds half-up',
    netUnitPrice(10000, 3) === 3333, String(netUnitPrice(10000, 3)));
  check('net unit price of zero quantity is zero', netUnitPrice(5000, 0) === 0);

  // ── SET UP A THROWAWAY SHOP ────────────────────────────────────────────
  const location = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true }
  });
  locationId = location.id;

  const customer = await prisma.customer.create({
    data: { clientId: CLIENT, customerCode: 'CUS-1', name: 'Test Buyer', status: 'ACTIVE' }
  });
  customerId = customer.id;

  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-PRICING', title: 'Kanchipuram Silk Saree',
      slug: 'kanchi-pricing', category: 'WOMEN', basePrice: 12000, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });

  for (const [key, price, cost] of [['saree', 12000, 7000], ['blouse', 800, 300]] as const) {
    const v = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: `SKU-${key.toUpperCase()}`,
        variantCode: `VAR-${key.toUpperCase()}`,
        size: 'Free Size', colorName: 'Red', sellingPrice: price, averageCost: cost
      }
    });
    variants[key] = v.id;
  }

  // ── D. THE OLD BEHAVIOUR, UNCHANGED ────────────────────────────────────
  console.log('\nD. A CALLER THAT SAYS NOTHING ABOUT PRICE (the old path)');

  const plain = await placeOrder([{ variantId: variants.saree, quantity: 2 }]);
  check('priced from the catalogue', plain.items[0].priceSource === 'CATALOGUE', plain.items[0].priceSource);
  check('list and net are the same', num(plain.items[0].listUnitPrice) === 12000 && num(plain.items[0].unitPrice) === 12000);
  check('subtotal is the gross', num(plain.subtotal) === 24000, String(plain.subtotal));
  check('nothing was discounted', num(plain.discountAmount) === 0);
  check('total matches the old formula', num(plain.total) === 24000, String(plain.total));
  check('gross profit is revenue less cost', num(plain.items[0].grossProfit) === 24000 - 14000, String(plain.items[0].grossProfit));

  // ── E. A SELLING SYSTEM THAT STATES ITS PRICE ──────────────────────────
  console.log('\nE. A SELLING SYSTEM THAT STATES ITS PRICE');

  const external = await placeOrder([
    { variantId: variants.saree, quantity: 1, unitPrice: 11000 }
  ]);
  check('the caller\'s price is kept, not overwritten',
    num(external.items[0].unitPrice) === 11000, String(external.items[0].unitPrice));
  check('recorded as EXTERNAL', external.items[0].priceSource === 'EXTERNAL');
  check('no discount is invented from the catalogue difference',
    num(external.items[0].lineDiscount) === 0 && num(external.items[0].listUnitPrice) === 11000,
    `list=${external.items[0].listUnitPrice} disc=${external.items[0].lineDiscount}`);
  check('gross profit follows the price charged',
    num(external.items[0].grossProfit) === 11000 - 7000, String(external.items[0].grossProfit));

  // ── F. THE HEADLINE CASE ───────────────────────────────────────────────
  console.log('\nF. ₹12,000 SAREE SOLD AT ₹9,600 AFTER ₹2,400 OFF');

  const discounted = await placeOrder([
    { variantId: variants.saree, quantity: 1, listUnitPrice: 12000, lineDiscount: 2400, unitPrice: 9600 }
  ]);
  const line = discounted.items[0];
  check('the gross is remembered', num(line.listUnitPrice) === 12000, String(line.listUnitPrice));
  check('the discount is remembered', num(line.lineDiscount) === 2400, String(line.lineDiscount));
  check('the net is what was charged', num(line.totalPrice) === 9600, String(line.totalPrice));
  check('GROSS PROFIT IS FROM THE NET, NOT THE LIST',
    num(line.grossProfit) === 9600 - 7000, `${line.grossProfit} (was 5000 before this fix)`);
  check('the order agrees with its own line', num(discounted.discountAmount) === 2400, String(discounted.discountAmount));
  check('subtotal is still the gross', num(discounted.subtotal) === 12000, String(discounted.subtotal));
  check('total is subtotal less discount', num(discounted.total) === 9600, String(discounted.total));

  // ── G. PRICES THAT CONTRADICT EACH OTHER ───────────────────────────────
  console.log('\nG. PRICES THAT CONTRADICT EACH OTHER');

  await refuses('all three sent and they do not add up', 'do not add up', () =>
    placeOrder([{ variantId: variants.saree, quantity: 1, listUnitPrice: 12000, lineDiscount: 2400, unitPrice: 9000 }]));

  await refuses('a discount bigger than the line', 'larger than the line', () =>
    placeOrder([{ variantId: variants.saree, quantity: 1, listUnitPrice: 12000, lineDiscount: 15000 }]));

  await refuses('an order discount smaller than its own lines', 'already account for', () =>
    placeOrder(
      [{ variantId: variants.saree, quantity: 1, listUnitPrice: 12000, lineDiscount: 2400 }],
      { discountAmount: 1000 }
    ));

  await refuses('an order discount bigger than the order', 'more than the order is worth', () =>
    placeOrder([{ variantId: variants.blouse, quantity: 1 }], { discountAmount: 5000 }));

  // More than two decimal places is refused at the door by the validator rather than rounded
  // silently somewhere in the middle of the calculation.
  const { createFullOrderSchema } = await import('../validations/sales-order.schema');
  const thirdDecimal = createFullOrderSchema.safeParse({
    customer: { id: customerId }, locationId,
    items: [{ variantId: variants.saree, quantity: 1, unitPrice: 12.345 }]
  });
  check('a price with three decimal places is refused', !thirdDecimal.success);

  // ── H. ONE DISCOUNT SPREAD ACROSS SEVERAL LINES ────────────────────────
  console.log('\nH. ONE DISCOUNT SPREAD ACROSS SEVERAL LINES');

  const spread = await placeOrder(
    [
      { variantId: variants.saree, quantity: 2 },   // 24000
      { variantId: variants.blouse, quantity: 1 }   // 800
    ],
    { discountAmount: 100 }
  );
  const shares = spread.items.map(i => num(i.allocatedDiscount));
  check('the shares add up to exactly the discount',
    shares.reduce((a, b) => a + b, 0) === 100, JSON.stringify(shares));
  check('  ...weighted by line value, not split evenly',
    shares[0] > shares[1], JSON.stringify(shares));
  check('each line\'s total is its gross less its share',
    num(spread.items[0].totalPrice) === 24000 - shares[0] &&
    num(spread.items[1].totalPrice) === 800 - shares[1]);
  check('gross profit on each line reflects its share',
    num(spread.items[0].grossProfit) === (24000 - shares[0]) - 14000, String(spread.items[0].grossProfit));
  check('subtotal is still the gross', num(spread.subtotal) === 24800, String(spread.subtotal));
  check('total is unchanged from the old formula', num(spread.total) === 24700, String(spread.total));

  const threeWay = await placeOrder(
    [
      { variantId: variants.blouse, quantity: 1 },
      { variantId: variants.blouse, quantity: 1 },
      { variantId: variants.blouse, quantity: 1 }
    ],
    { discountAmount: 100 }
  );
  const evenShares = threeWay.items.map(i => num(i.allocatedDiscount));
  check('₹100 across three IDENTICAL lines loses no paisa',
    evenShares.reduce((a, b) => a + b, 0) === 100, JSON.stringify(evenShares));
  check('  ...and the lines still sum to the order total',
    threeWay.items.reduce((s, i) => s + num(i.totalPrice), 0) === num(threeWay.total),
    `${threeWay.items.reduce((s, i) => s + num(i.totalPrice), 0)} vs ${threeWay.total}`);

  // ── I. TAX AND SHIPPING ARE UNTOUCHED ──────────────────────────────────
  console.log('\nI. TAX AND SHIPPING ARE RECORDED, NOT COMPUTED');

  const withExtras = await placeOrder(
    [{ variantId: variants.saree, quantity: 1 }],
    { discountAmount: 1000, taxAmount: 540, shippingAmount: 120 }
  );
  check('tax is kept exactly as sent', num(withExtras.taxAmount) === 540);
  check('shipping is kept exactly as sent', num(withExtras.shippingAmount) === 120);
  check('total = subtotal - discount + tax + shipping',
    num(withExtras.total) === 12000 - 1000 + 540 + 120, String(withExtras.total));

  // ── J. EDITING A DRAFT ─────────────────────────────────────────────────
  console.log('\nJ. EDITING A DRAFT AFTER A DISCOUNT WAS TYPED');

  const draft = await salesOrderService.createDraftOrder(CLIENT, locationId, customerId, 'POS');
  await salesOrderService.addOrderItem(CLIENT, draft.id, variants.saree, 1);
  await salesOrderService.updateOrder(CLIENT, draft.id, { discountAmount: 600 });

  let edited = await readOrder(draft.id);
  check('the whole discount lands on the only line',
    num(edited.items[0].allocatedDiscount) === 600, String(edited.items[0].allocatedDiscount));

  const secondItem = await salesOrderService.addOrderItem(CLIENT, draft.id, variants.blouse, 1);
  edited = await readOrder(draft.id);
  const afterAdd = edited.items.map(i => num(i.allocatedDiscount));
  check('adding a line re-spreads the discount over both',
    afterAdd.reduce((a, b) => a + b, 0) === 600 && afterAdd[1] > 0, JSON.stringify(afterAdd));
  check('the order still says 600 came off', num(edited.discountAmount) === 600, String(edited.discountAmount));

  // Recalculating without changing anything must not move a single paisa -- this runs after
  // every edit, and a calculation that drifts each time it is repeated is worse than one that
  // is simply wrong.
  const before = JSON.stringify(edited.items.map(i => [String(i.allocatedDiscount), String(i.totalPrice), String(i.unitPrice)]));
  await salesOrderService.updateOrder(CLIENT, draft.id, {});
  edited = await readOrder(draft.id);
  const after = JSON.stringify(edited.items.map(i => [String(i.allocatedDiscount), String(i.totalPrice), String(i.unitPrice)]));
  check('recalculating twice changes nothing', before === after, `${before} vs ${after}`);

  await salesOrderService.removeOrderItem(CLIENT, draft.id, secondItem.id);
  edited = await readOrder(draft.id);
  check('removing a line puts its share back on the rest',
    num(edited.items[0].allocatedDiscount) === 600 && num(edited.discountAmount) === 600,
    `${edited.items[0].allocatedDiscount} / ${edited.discountAmount}`);

  // A discount that outgrows the order it is on. Clamped rather than refused: the merchant is
  // editing, and refusing here would leave them unable to remove the line at all.
  const shrinking = await salesOrderService.createDraftOrder(CLIENT, locationId, customerId, 'POS');
  const keep = await salesOrderService.addOrderItem(CLIENT, shrinking.id, variants.blouse, 1);
  const drop = await salesOrderService.addOrderItem(CLIENT, shrinking.id, variants.saree, 1);
  await salesOrderService.updateOrder(CLIENT, shrinking.id, { discountAmount: 1000 });
  await salesOrderService.removeOrderItem(CLIENT, shrinking.id, drop.id);
  const clamped = await readOrder(shrinking.id);
  check('a discount bigger than what is left is clamped, not refused',
    num(clamped.discountAmount) === 800 && num(clamped.total) === 0,
    `discount=${clamped.discountAmount} total=${clamped.total}`);
  check('  ...and no line is sold for less than nothing',
    clamped.items.every(i => num(i.totalPrice) >= 0));

  await salesOrderService.removeOrderItem(CLIENT, shrinking.id, keep.id);
  const empty = await readOrder(shrinking.id);
  check('removing the last line keeps the typed discount',
    num(empty.discountAmount) === 800 && num(empty.subtotal) === 0,
    `discount=${empty.discountAmount} subtotal=${empty.subtotal}`);

  // ── K. WHAT THE DAY BOOK AND DISPATCH READ ─────────────────────────────
  console.log('\nK. WHAT THE DAY BOOK AND DISPATCH READ');

  // Both value a part-shipped order as unitPrice x dispatched quantity. That only gives the
  // right revenue if unitPrice is the NET price -- which, before this change, it was not.
  const partial = await placeOrder([
    { variantId: variants.saree, quantity: 3, listUnitPrice: 12000, lineDiscount: 3000 }
  ]);
  const unit = num(partial.items[0].unitPrice);
  check('unitPrice is the net, not the list', unit === 11000, String(unit));
  check('one of three units is valued at the discounted rate',
    unit * 1 === 11000, String(unit));
  check('all three add back up to the line total',
    unit * 3 === num(partial.items[0].totalPrice), `${unit * 3} vs ${partial.items[0].totalPrice}`);

  // ── M. REVENUE RECOGNISED AS GOODS LEAVE ───────────────────────────────
  console.log('\nM. REVENUE RECOGNISED AS GOODS LEAVE');

  // Three items sold for ₹7,458.32 have no whole-paisa unit price. Dispatching them in two
  // goes must still recognise ₹7,458.32 in total, not ₹7,458.33.
  for (const key of ['saree', 'blouse'] as const) {
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: variants[key], locationId, quantity: 50, reservedQty: 0 }
    });
  }

  const shipped = await placeOrder(
    [{ variantId: variants.saree, quantity: 3, listUnitPrice: 2500, lineDiscount: 41.68 }],
    { status: 'CONFIRMED' }
  );
  const shippedLine = shipped.items[0];
  check('the line has an uneven per-unit price',
    num(shippedLine.totalPrice) === 7458.32 && num(shippedLine.unitPrice) === 2486.11,
    `total=${shippedLine.totalPrice} unit=${shippedLine.unitPrice}`);

  await dispatchService.createDispatch(CLIENT, shipped.id, [{ salesOrderItemId: shippedLine.id, quantity: 1 }]);
  await dispatchService.createDispatch(CLIENT, shipped.id, [{ salesOrderItemId: shippedLine.id, quantity: 2 }]);

  const ledger = await prisma.salesLedger.findMany({
    where: { salesOrderId: shipped.id }, select: { revenue: true }
  });
  const recognised = ledger.reduce((sum, l) => sum + num(l.revenue), 0);
  check('two dispatches recognise the line total EXACTLY',
    recognised === 7458.32, `${recognised} across ${ledger.length} dispatches (unit x qty would give 7458.33)`);

  // ── L. HISTORICAL ROWS WERE NOT REWRITTEN ──────────────────────────────
  console.log('\nL. HISTORICAL ROWS WERE NOT REWRITTEN');

  const legacy: any[] = await prisma.$queryRaw`
    SELECT count(*)::int AS mismatched
    FROM sales_order_items
    WHERE price_source = 'CATALOGUE'
      AND line_discount = 0
      AND allocated_discount = 0
      AND list_unit_price <> unit_price`;
  check('every backfilled row has list = unit price', legacy[0].mismatched === 0, JSON.stringify(legacy[0]));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    // Everything this suite made, gone -- it runs against the live database.
    await prisma.salesLedger.deleteMany({ where: { clientId: CLIENT } });
    await prisma.dispatchItem.deleteMany({ where: { dispatch: { clientId: CLIENT } } });
    await prisma.dispatch.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryReservation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } });
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.salesOrder.deleteMany({ where: { clientId: CLIENT } });
    await prisma.customer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
