/**
 * A discounted order, followed all the way through the business.
 *
 * verify-order-pricing proves the arithmetic. This proves it survives contact with everything
 * downstream: confirming, reserving, shipping in instalments, the sales ledger, the day book,
 * returning goods, and cancelling.
 *
 * The cases here are the ones nobody sends on purpose -- a line given away free, a ten-line
 * order with one rupee off it, an order discounted to exactly nothing, a merchant who edits the
 * discount three times and then removes the first line rather than the last. Each of them is a
 * plausible afternoon in a shop, and each one is a place where a paisa can appear or vanish.
 *
 * Throwaway tenant, deleted at the end, so this is safe against the live database.
 *
 *   npx tsx src/scripts/verify-order-money-lifecycle.ts
 */
import { prisma } from '../lib/prisma';
import { salesOrderService } from '../services/sales-order.service';
import { dispatchService } from '../services/dispatch.service';
import { returnService } from '../services/return.service';
import { dayBookService } from '../services/daybook.service';
import { todayKey } from '../utils/businessDay';
import { getShopSettings } from '../lib/clientSettings';
import { toMinor } from '../services/pricing';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `lifecycle-${Date.now()}`;
const num = (v: any) => Number(v);
/** Compare money in paise, so 7458.3299999 never fails a test that is actually correct. */
const sameMoney = (a: any, b: any) => toMinor(a) === toMinor(b);

let locationId = '';
let customerId = '';
const variants: Record<string, string> = {};

async function placeOrder(items: any[], orderFields: any = {}) {
  const order = await salesOrderService.createFullOrder(
    CLIENT, locationId, { customer: { id: customerId }, items, ...orderFields }, 'ONLINE'
  );
  return readOrder(order.id);
}

async function readOrder(id: string) {
  return prisma.salesOrder.findUniqueOrThrow({
    where: { id }, include: { items: { orderBy: { createdAt: 'asc' } } }
  });
}

const ledgerFor = async (salesOrderId: string) =>
  prisma.salesLedger.findMany({ where: { salesOrderId }, orderBy: { createdAt: 'asc' } });

async function main() {
  // ── SET UP A THROWAWAY SHOP ────────────────────────────────────────────
  const location = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true }
  });
  locationId = location.id;

  const customer = await prisma.customer.create({
    data: { clientId: CLIENT, customerCode: 'CUS-1', name: 'Lifecycle Buyer', status: 'ACTIVE' }
  });
  customerId = customer.id;

  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-LIFE', title: 'Kanchipuram Silk Saree',
      slug: 'kanchi-life', category: 'WOMEN', basePrice: 12000, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });

  // A free item is in here on purpose: a zero-priced line is what breaks a weighted split.
  const catalogue = [
    ['saree', 12000, 7000], ['blouse', 800, 300], ['petticoat', 450, 180],
    ['gift', 0, 120]
  ] as const;

  for (const [key, price, cost] of catalogue) {
    const v = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: `SKU-${key.toUpperCase()}`,
        variantCode: `VAR-${key.toUpperCase()}`, size: 'Free Size', colorName: 'Red',
        sellingPrice: price, averageCost: cost
      }
    });
    variants[key] = v.id;
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: v.id, locationId, quantity: 200, reservedQty: 0 }
    });
  }

  // ── A. ONE ORDER, SHIPPED IN THREE GOES ────────────────────────────────
  console.log('\nA. A DISCOUNTED ORDER SHIPPED IN THREE INSTALMENTS');

  const staged = await placeOrder(
    [
      { variantId: variants.saree, quantity: 5, listUnitPrice: 12000, lineDiscount: 2400 },
      { variantId: variants.blouse, quantity: 2 }
    ],
    { status: 'CONFIRMED', discountAmount: 2500 }
  );
  const sareeLine = staged.items[0];
  const blouseLine = staged.items[1];

  check('the order carries both kinds of discount',
    sameMoney(sareeLine.lineDiscount, 2400) && num(sareeLine.allocatedDiscount) > 0,
    `line=${sareeLine.lineDiscount} alloc=${sareeLine.allocatedDiscount}`);
  check('the order total equals the sum of its lines',
    sameMoney(num(sareeLine.totalPrice) + num(blouseLine.totalPrice), staged.total),
    `${num(sareeLine.totalPrice) + num(blouseLine.totalPrice)} vs ${staged.total}`);

  await dispatchService.createDispatch(CLIENT, staged.id, [{ salesOrderItemId: sareeLine.id, quantity: 2 }]);
  let mid = await readOrder(staged.id);
  check('a part shipment leaves the order PARTIALLY_DISPATCHED',
    mid.status === 'PARTIALLY_DISPATCHED', mid.status);

  await dispatchService.createDispatch(CLIENT, staged.id, [
    { salesOrderItemId: sareeLine.id, quantity: 3 },
    { salesOrderItemId: blouseLine.id, quantity: 1 }
  ]);
  await dispatchService.createDispatch(CLIENT, staged.id, [{ salesOrderItemId: blouseLine.id, quantity: 1 }]);

  const done = await readOrder(staged.id);
  check('shipping the last unit closes the order', done.status === 'DISPATCHED', done.status);

  const ledger = await ledgerFor(staged.id);
  const recognised = ledger.reduce((s, l) => s + num(l.revenue), 0);
  const lineTotals = done.items.reduce((s, i) => s + num(i.totalPrice), 0);
  check('three dispatches recognise the order EXACTLY, no more and no less',
    sameMoney(recognised, lineTotals), `${recognised} recognised vs ${lineTotals} sold`);

  const cogs = ledger.reduce((s, l) => s + num(l.costOfGoods), 0);
  check('cost of goods matches what left the shelf',
    sameMoney(cogs, 5 * 7000 + 2 * 300), String(cogs));
  check('gross profit in the ledger is revenue less cost',
    sameMoney(ledger.reduce((s, l) => s + num(l.grossProfit), 0), recognised - cogs));

  const stock = await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: variants.saree, locationId } });
  check('physical stock fell by exactly what was shipped', stock.quantity === 195, String(stock.quantity));
  check('nothing is left reserved once everything has gone', stock.reservedQty === 0, String(stock.reservedQty));

  // ── B. THE DAY BOOK SEES THE DISCOUNTED PRICE ──────────────────────────
  console.log('\nB. THE DAY BOOK SEES WHAT WAS CHARGED, NOT WHAT WAS LISTED');

  // The SHOP's today, not UTC's. This used to be toISOString().slice(0, 10), which between
  // midnight and 5:30am in India names yesterday -- so the day book was asked about the wrong day
  // and reported nothing, and the suite failed every night for a reason that had nothing to do
  // with money. The day book itself was right; the question was wrong.
  const { timezone } = await getShopSettings(CLIENT);
  const today = todayKey(timezone);
  const day = await dayBookService.getDay(CLIENT, today);
  const daySales = num((day as any)?.sales?.revenue ?? (day as any)?.revenue ?? 0);
  check('the day book reports the discounted revenue',
    sameMoney(daySales, lineTotals),
    `day book ${daySales} vs sold ${lineTotals} (list price would be ${5 * 12000 + 2 * 800})`);

  // ── C. A LINE GIVEN AWAY ───────────────────────────────────────────────
  console.log('\nC. A LINE GIVEN AWAY FREE');

  const freebie = await placeOrder(
    [
      { variantId: variants.saree, quantity: 1 },
      { variantId: variants.gift, quantity: 1 }
    ],
    { status: 'CONFIRMED' }
  );
  check('a zero-priced line is accepted', num(freebie.items[1].totalPrice) === 0);
  check('  ...and does not drag the order to zero', sameMoney(freebie.total, 12000), String(freebie.total));

  await dispatchService.createDispatch(CLIENT, freebie.id, [
    { salesOrderItemId: freebie.items[0].id, quantity: 1 },
    { salesOrderItemId: freebie.items[1].id, quantity: 1 }
  ]);
  const freeLedger = await ledgerFor(freebie.id);
  check('the free item earns no revenue', sameMoney(freeLedger[0].revenue, 12000), String(freeLedger[0].revenue));
  check('  ...but its cost is still recognised',
    sameMoney(freeLedger[0].costOfGoods, 7000 + 120), String(freeLedger[0].costOfGoods));

  // A paid line marked down to nothing -- the "free with purchase" a merchant actually types.
  const markedDown = await placeOrder([
    { variantId: variants.saree, quantity: 1 },
    { variantId: variants.blouse, quantity: 1, listUnitPrice: 800, lineDiscount: 800 }
  ]);
  check('a line discounted to exactly nothing is allowed',
    num(markedDown.items[1].totalPrice) === 0 && sameMoney(markedDown.items[1].lineDiscount, 800),
    `total=${markedDown.items[1].totalPrice}`);
  check('  ...and the order still shows what it gave away',
    sameMoney(markedDown.discountAmount, 800), String(markedDown.discountAmount));

  // ── D. SPLITS THAT DO NOT DIVIDE ───────────────────────────────────────
  console.log('\nD. SPLITS THAT DO NOT DIVIDE');

  const tenLines = await placeOrder(
    Array.from({ length: 10 }, () => ({ variantId: variants.petticoat, quantity: 1 })),
    { discountAmount: 1 }
  );
  const tenShares = tenLines.items.map(i => toMinor(i.allocatedDiscount));
  check('₹1 across ten lines sums to exactly 100 paise',
    tenShares.reduce((a, b) => a + b, 0) === 100, JSON.stringify(tenShares));
  check('  ...and every line got the same 10 paise',
    tenShares.every(s => s === 10), JSON.stringify(tenShares));

  const onePaisa = await placeOrder(
    [
      { variantId: variants.petticoat, quantity: 1 },
      { variantId: variants.petticoat, quantity: 1 },
      { variantId: variants.petticoat, quantity: 1 }
    ],
    { discountAmount: 0.01 }
  );
  const paiseShares = onePaisa.items.map(i => toMinor(i.allocatedDiscount));
  check('a single paisa across three lines goes to exactly one of them',
    paiseShares.reduce((a, b) => a + b, 0) === 1 && paiseShares.filter(s => s === 1).length === 1,
    JSON.stringify(paiseShares));

  const withFree = await placeOrder(
    [
      { variantId: variants.gift, quantity: 1 },      // worth nothing
      { variantId: variants.blouse, quantity: 1 }     // worth 800
    ],
    { discountAmount: 100 }
  );
  check('a discount skips the line that is worth nothing',
    toMinor(withFree.items[0].allocatedDiscount) === 0 && sameMoney(withFree.items[1].allocatedDiscount, 100),
    `${withFree.items[0].allocatedDiscount} / ${withFree.items[1].allocatedDiscount}`);
  check('  ...and no line ends up negative',
    withFree.items.every(i => num(i.totalPrice) >= 0));

  const freeOrder = await placeOrder(
    [{ variantId: variants.blouse, quantity: 1 }], { discountAmount: 800 }
  );
  check('an order discounted to exactly nothing totals zero',
    num(freeOrder.total) === 0 && num(freeOrder.items[0].totalPrice) === 0,
    `total=${freeOrder.total}`);

  // ── E. A MERCHANT CHANGING THEIR MIND ──────────────────────────────────
  console.log('\nE. A MERCHANT CHANGING THEIR MIND');

  const draft = await salesOrderService.createDraftOrder(CLIENT, locationId, customerId, 'POS');
  const first = await salesOrderService.addOrderItem(CLIENT, draft.id, variants.saree, 1);
  const second = await salesOrderService.addOrderItem(CLIENT, draft.id, variants.blouse, 2);
  const third = await salesOrderService.addOrderItem(CLIENT, draft.id, variants.petticoat, 1);

  for (const amount of [600, 300, 0, 600]) {
    await salesOrderService.updateOrder(CLIENT, draft.id, { discountAmount: amount });
    const edited = await readOrder(draft.id);
    const shares = edited.items.reduce((s, i) => s + toMinor(i.allocatedDiscount), 0);
    check(`discount set to ${amount}: the lines carry exactly that`,
      shares === toMinor(amount) && sameMoney(edited.discountAmount, amount),
      `lines=${shares / 100} order=${edited.discountAmount}`);
  }

  // Removing the FIRST line, not the last -- the share it was holding has to go back to the
  // others rather than leaving with it and quietly raising the total.
  await salesOrderService.removeOrderItem(CLIENT, draft.id, first.id);
  const afterRemove = await readOrder(draft.id);
  check('removing the first line redistributes its share',
    afterRemove.items.reduce((s, i) => s + toMinor(i.allocatedDiscount), 0) === 60000 &&
    sameMoney(afterRemove.discountAmount, 600),
    `discount=${afterRemove.discountAmount}`);
  check('  ...and the total is still subtotal less discount',
    sameMoney(afterRemove.total, num(afterRemove.subtotal) - 600), String(afterRemove.total));

  void second; void third;

  // ── F. IDEMPOTENCY AND MIXED SOURCES ───────────────────────────────────
  console.log('\nF. THE SAME ORDER ARRIVING TWICE');

  const ext = `EXT-LIFE-${Date.now()}`;
  const payload = {
    externalOrderId: ext, sourceSystem: 'STOREFRONT', discountAmount: 2400,
    items: [
      { variantId: variants.saree, quantity: 1, listUnitPrice: 12000, lineDiscount: 2400 },
      { variantId: variants.blouse, quantity: 1 }
    ]
  };
  const once = await placeOrder(payload.items, payload);
  const twice = await placeOrder(payload.items, payload);
  check('a replayed storefront order is the same order', once.id === twice.id);
  check('  ...and the discount was not applied a second time',
    sameMoney(twice.discountAmount, 2400) && sameMoney(twice.total, once.total),
    `${twice.discountAmount} / ${twice.total}`);
  check('one order carries both a stated and a catalogue price',
    once.items[0].priceSource === 'EXTERNAL' && once.items[1].priceSource === 'CATALOGUE',
    `${once.items[0].priceSource} / ${once.items[1].priceSource}`);

  // ── G. GOODS COMING BACK ───────────────────────────────────────────────
  console.log('\nG. GOODS COMING BACK');

  const sold = await placeOrder(
    [{ variantId: variants.saree, quantity: 3, listUnitPrice: 12000, lineDiscount: 7200 }],
    { status: 'CONFIRMED' }
  );
  const soldLine = sold.items[0];
  const dispatch: any = await dispatchService.createDispatch(
    CLIENT, sold.id, [{ salesOrderItemId: soldLine.id, quantity: 3 }]
  );
  const beforeReturn = await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: variants.saree, locationId } });

  const ret = await returnService.createReturn(
    CLIENT, sold.id, [{ dispatchItemId: dispatch.items[0].id, quantity: 1 }], 'changed mind', 'OTHER'
  );
  await returnService.receiveReturn(CLIENT, ret.id);
  await returnService.inspectReturn(CLIENT, ret.id, [{ salesReturnItemId: ret.items[0].id, disposition: 'RESTOCK' }]);
  await returnService.completeReturn(CLIENT, ret.id);

  const afterReturn = await prisma.inventoryStock.findFirstOrThrow({ where: { variantId: variants.saree, locationId } });
  check('a returned unit goes back on the shelf',
    afterReturn.quantity === beforeReturn.quantity + 1,
    `${beforeReturn.quantity} -> ${afterReturn.quantity}`);

  const soldAfter = await readOrder(sold.id);
  check('the order still records what the customer paid',
    sameMoney(soldAfter.items[0].totalPrice, 28800), String(soldAfter.items[0].totalPrice));
  /*
   * A return can now carry money -- the columns arrived with Phase 1 -- but OUR return flow does
   * not put anything in them yet. A return raised here still only moves stock; a Shopify refund
   * is what fills these in, because Shopify has already paid the customer back.
   *
   * This tripwire was the previous version of this check, and it fired the moment the migration
   * landed, which is what it was for. It now guards the other half: the day our own returns
   * start refunding, this fails and somebody has to decide what the number should be. It is the
   * NET of the line -- 9,600 here -- never the 12,000 it is listed at.
   */
  const returnRow: any = await prisma.salesReturn.findUniqueOrThrow({ where: { id: ret.id } });
  check('a return raised here carries the money columns',
    returnRow.refundTotal !== undefined && returnRow.refundStatus !== undefined,
    'the Phase 1 refund columns are missing');
  // The day came: returns raised here now record what is owed. As decided when this tripwire was
  // set, the answer is the NET paid for the line -- 9,600 -- never the 12,000 it is listed at, and
  // PENDING because the shop hands it back at the counter rather than Shopify having paid it.
  check('  ...owing the NET price paid, never the list price',
    num(returnRow.refundTotal) === 9600 && returnRow.refundStatus === 'PENDING',
    `${returnRow.refundTotal} / ${returnRow.refundStatus} (list price would be 12000)`);

  // ── H. AN ORDER THAT NEVER HAPPENS ─────────────────────────────────────
  console.log('\nH. AN ORDER THAT NEVER HAPPENS');

  const doomed = await placeOrder(
    [{ variantId: variants.saree, quantity: 2, listUnitPrice: 12000, lineDiscount: 1000 }],
    { status: 'CONFIRMED', discountAmount: 1500 }
  );
  const reservedBefore = (await prisma.inventoryStock.findFirstOrThrow({
    where: { variantId: variants.saree, locationId }
  })).reservedQty;

  await salesOrderService.cancelOrder(CLIENT, doomed.id);
  const cancelled = await readOrder(doomed.id);
  const reservedAfter = (await prisma.inventoryStock.findFirstOrThrow({
    where: { variantId: variants.saree, locationId }
  })).reservedQty;

  check('cancelling releases the reservation',
    reservedAfter === reservedBefore - 2, `${reservedBefore} -> ${reservedAfter}`);
  check('  ...and the order keeps its figures for the record',
    cancelled.status === 'CANCELLED' && sameMoney(cancelled.discountAmount, 1500),
    `${cancelled.status} / ${cancelled.discountAmount}`);
  check('no revenue was ever recognised for it', (await ledgerFor(doomed.id)).length === 0);

  // ── J. THE SAME BUTTON PRESSED TWICE ───────────────────────────────────
  console.log('\nJ. THE SAME BUTTON PRESSED TWICE');

  /*
   * Found by pressing Confirm three times in the UI, not by reading the code.
   *
   * confirmOrder read the status, checked it, reserved, then wrote CONFIRMED -- all inside a
   * transaction, which its own comment said was enough. It is not: at the default isolation
   * level every concurrent copy reads DRAFT, every one passes the check, and every one
   * reserves. A 3+2+1 order came back with NINE reservation rows holding EIGHTEEN units, and
   * the order screen showed RESERVED 3 / 2 / 1 throughout, so nothing on it looked wrong.
   */
  const raced = await placeOrder([
    { variantId: variants.saree, quantity: 3 },
    { variantId: variants.blouse, quantity: 2 },
    { variantId: variants.petticoat, quantity: 1 }
  ]);

  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => salesOrderService.confirmOrder(CLIENT, raced.id))
  );
  const ok = attempts.filter(a => a.status === 'fulfilled').length;
  const refused = attempts.filter(
    a => a.status === 'rejected' && (a as any).reason?.statusCode === 409
  ).length;

  check('exactly one of five simultaneous confirms succeeds', ok === 1, `${ok} succeeded`);
  check('  ...and the rest are refused as a conflict, not a crash',
    refused + ok === 5, `${refused} refused with 409, ${ok} succeeded, of 5`);

  const racedRows = await prisma.inventoryReservation.findMany({
    where: { salesOrderItem: { salesOrderId: raced.id } },
    select: { reservedQty: true, salesOrderItemId: true }
  });
  check('one reservation per line, not five',
    racedRows.length === 3, `${racedRows.length} reservation rows for 3 lines`);
  check('  ...holding exactly what was ordered',
    racedRows.reduce((s, r) => s + r.reservedQty, 0) === 6,
    `${racedRows.reduce((s, r) => s + r.reservedQty, 0)} units reserved for an order of 6`);

  // And the release has to find every one of them. It used to take findFirst, so any duplicate
  // row stayed reserved for ever -- stock that is not missing and not sellable either.
  const beforeRelease = await prisma.inventoryStock.findFirstOrThrow({
    where: { variantId: variants.saree, locationId }, select: { reservedQty: true }
  });
  await salesOrderService.cancelOrder(CLIENT, raced.id);
  const afterRelease = await prisma.inventoryStock.findFirstOrThrow({
    where: { variantId: variants.saree, locationId }, select: { reservedQty: true }
  });
  check('cancelling releases every reservation it made',
    afterRelease.reservedQty === beforeRelease.reservedQty - 3,
    `${beforeRelease.reservedQty} -> ${afterRelease.reservedQty}`);

  // ── I. EVERY ORDER THIS SUITE MADE, RECONCILED ─────────────────────────
  console.log('\nI. EVERY ORDER THIS SUITE MADE, RECONCILED');

  const all = await prisma.salesOrder.findMany({
    where: { clientId: CLIENT }, include: { items: true }
  });
  const mismatched = all.filter(o => {
    const gross = o.items.reduce((s, i) => s + toMinor(i.listUnitPrice) * i.quantity, 0);
    const off = o.items.reduce((s, i) => s + toMinor(i.lineDiscount) + toMinor(i.allocatedDiscount), 0);
    const net = o.items.reduce((s, i) => s + toMinor(i.totalPrice), 0);
    return gross - off !== net
      || toMinor(o.subtotal) !== gross
      || toMinor(o.discountAmount) !== off
      || toMinor(o.total) !== net + toMinor(o.taxAmount) + toMinor(o.shippingAmount);
  });
  check(`all ${all.length} orders balance to the paisa`,
    mismatched.length === 0, mismatched.map(o => o.orderNumber).join(', '));

  const negatives = await prisma.salesOrderItem.count({
    where: { salesOrder: { clientId: CLIENT }, totalPrice: { lt: 0 } }
  });
  check('no line was ever sold for less than nothing', negatives === 0, String(negatives));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.salesReturnItem.deleteMany({ where: { salesReturn: { clientId: CLIENT } } });
    await prisma.salesReturn.deleteMany({ where: { clientId: CLIENT } });
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
