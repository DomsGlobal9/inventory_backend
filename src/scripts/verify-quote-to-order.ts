/**
 * From "what does this cost" to "this is what we charged".
 *
 * verify-pricing-engine proves the arithmetic. verify-pricing-quote proves the right offers are
 * loaded and the answer is frozen. This proves the last and most dangerous step: that the frozen
 * answer is what the ORDER records, that the offer's allowance is actually spent, and that a
 * person taking money off by hand leaves a record of why.
 *
 * The failures this is looking for are the ones a shop discovers months later:
 *
 *   - an order re-priced at save time, so the customer is charged more than they were shown
 *   - a quote spent twice, so one checkout's price is replayed onto another order
 *   - "first 50 customers" serving fifty-one, because two checkouts both read 49
 *   - a cancelled order keeping its allowance, so an offer runs out without selling anything
 *   - 200 off with nothing beside it saying who decided, or why
 *
 * Throwaway tenant, deleted at the end.
 *
 *   npx tsx src/scripts/verify-quote-to-order.ts
 */
import { prisma } from '../lib/prisma';
import { pricingQuoteService } from '../services/pricing';
import { offerService } from '../services/offers';
import { salesOrderService } from '../services/sales-order.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

async function refuses(name: string, fragment: string, fn: () => Promise<any>) {
  try { await fn(); check(name, false, 'it was accepted'); }
  catch (e: any) {
    const msg = String(e?.message ?? e);
    check(name, msg.toLowerCase().includes(fragment.toLowerCase()), `"${msg}"`);
  }
}

const CLIENT = `q2o-${Date.now()}`;
const USER = 'till-operator';
const num = (v: any) => Number(v);
const yesterday = new Date(Date.now() - 86400000);

let locationId = '';
let customerId = '';
let otherCustomerId = '';
const V: Record<string, string> = {};

async function liveOffer(over: any = {}) {
  const offer: any = await offerService.create(CLIENT, {
    name: 'Offer', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE',
    value: 10, scope: 'ALL', startsAt: yesterday, endsAt: null, ...over
  } as any, USER);
  await offerService.setStatus(CLIENT, offer.id, 'ACTIVE', USER);
  return offer;
}

const quoteFor = (lines: any[], over: any = {}) => pricingQuoteService.quote(CLIENT, {
  locationId, channel: 'POS', lines, ...over
});

const orderFrom = (quote: any, lines: any[], over: any = {}) =>
  salesOrderService.createFullOrder(CLIENT, locationId, {
    customer: { id: customerId },
    quoteId: quote.quoteId,
    items: lines,
    ...over
  });

async function main() {
  // ── SETUP ──────────────────────────────────────────────────────────────
  console.log('SETUP: one shop, two products, stock for all of it');

  const loc = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true }
  });
  locationId = loc.id;

  customerId = (await prisma.customer.create({
    data: { clientId: CLIENT, customerCode: 'CUS-1', name: 'Regular', status: 'ACTIVE' }
  })).id;
  otherCustomerId = (await prisma.customer.create({
    data: { clientId: CLIENT, customerCode: 'CUS-2', name: 'Someone else', status: 'ACTIVE' }
  })).id;

  const women = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'PRD-W', title: 'Kanchipuram Silk Saree',
      slug: `w-${Date.now()}`, category: 'WOMEN', basePrice: 12000, status: 'ACTIVE',
      productType: 'READY_TO_WEAR'
    }
  });

  for (const [key, price] of [['saree', 12000], ['blouse', 800]] as const) {
    const v = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: women.id, sku: `SKU-${key}`, variantCode: `VAR-${key}`,
        size: 'Free Size', colorName: 'Red', sellingPrice: price, averageCost: 100
      }
    });
    V[key] = v.id;
    await prisma.inventoryStock.create({
      data: { clientId: CLIENT, variantId: v.id, locationId, quantity: 500, reservedQty: 0 }
    });
  }

  // ── A. THE QUOTED PRICE IS THE PRICE CHARGED ───────────────────────────
  console.log('\nA. AN ORDER IS HELD TO THE PRICE THAT WAS QUOTED');

  const twenty = await liveOffer({ name: 'Deepavali Sale', value: 20 });

  const basket = [{ variantId: V.saree, quantity: 2 }, { variantId: V.blouse, quantity: 1 }];
  const quote: any = await quoteFor(basket);
  check('the basket prices as expected', quote.total === 19840, String(quote.total));

  const order: any = await orderFrom(quote, basket);
  const items = await prisma.salesOrderItem.findMany({
    where: { salesOrderId: order.id }, orderBy: { createdAt: 'asc' }
  });
  const saree = items.find(i => i.variantId === V.saree)!;
  const blouse = items.find(i => i.variantId === V.blouse)!;

  check('the order total is the quoted total', num(order.total) === 19840, String(order.total));
  check('the saree line keeps its list price', num(saree.listUnitPrice) === 12000, String(saree.listUnitPrice));
  check('  ...and records what came off it', num(saree.lineDiscount) === 4800, String(saree.lineDiscount));
  check('  ...and what was actually charged per piece', num(saree.unitPrice) === 9600, String(saree.unitPrice));
  check('  ...and says the price came from a quote', saree.priceSource === 'QUOTE', saree.priceSource);
  check('the blouse is discounted too', num(blouse.totalPrice) === 640, String(blouse.totalPrice));
  check('gross profit is against the NET price',
    num(saree.grossProfit) === 19200 - 200, String(saree.grossProfit));

  /*
   * The whole point of the release. An offer that ends between the quote and the order must not
   * change what the customer pays -- they saw a number.
   */
  await offerService.setStatus(CLIENT, twenty.id, 'PAUSED', USER);
  const afterPause: any = await quoteFor([{ variantId: V.saree, quantity: 1 }]);
  check('a paused offer stops applying to NEW baskets', afterPause.total === 12000, String(afterPause.total));
  await offerService.setStatus(CLIENT, twenty.id, 'ACTIVE', USER);

  const frozenQuote: any = await quoteFor([{ variantId: V.saree, quantity: 1 }]);
  await offerService.setStatus(CLIENT, twenty.id, 'PAUSED', USER);
  const frozenOrder: any = await orderFrom(frozenQuote, [{ variantId: V.saree, quantity: 1 }]);
  check('an offer paused AFTER the quote does not change the price',
    num(frozenOrder.total) === 9600, String(frozenOrder.total));
  await offerService.setStatus(CLIENT, twenty.id, 'ACTIVE', USER);

  // ── B. WHY THE MONEY CAME OFF ──────────────────────────────────────────
  console.log('\nB. THE ORDER CAN SAY WHY, NOT ONLY THAT');

  const discounts = await prisma.salesOrderDiscount.findMany({
    where: { salesOrderId: order.id }, include: { allocations: true }
  });
  check('the offer is recorded on the order', discounts.length === 1, String(discounts.length));
  check('  ...named as the customer saw it', discounts[0]?.title === 'Deepavali Sale', discounts[0]?.title);
  check('  ...as an OFFER, not a manual markdown', discounts[0]?.source === 'OFFER', discounts[0]?.source);
  check('  ...pointing at the offer', discounts[0]?.offerId === twenty.id);
  check('  ...and at the VERSION, so it still reads correctly after an edit',
    !!discounts[0]?.offerVersionId);
  check('  ...for the whole amount', num(discounts[0]?.amount) === 4960, String(discounts[0]?.amount));

  const allocated = (discounts[0]?.allocations ?? []).reduce((s, a) => s + num(a.amount), 0);
  check('the allocations add up to the discount exactly', allocated === 4960, String(allocated));
  check('  ...one per line it touched', discounts[0]?.allocations.length === 2,
    String(discounts[0]?.allocations.length));

  // ── C. A QUOTE IS GOOD ONCE ────────────────────────────────────────────
  console.log('\nC. A QUOTE IS GOOD ONCE, FOR THE BASKET IT PRICED');

  await refuses('the same quote cannot be used on a second order', 'already been used',
    () => orderFrom(quote, basket));

  const changed: any = await quoteFor([{ variantId: V.saree, quantity: 1 }]);
  await refuses('a basket that changed since it was priced is refused', 'has changed',
    () => orderFrom(changed, [{ variantId: V.saree, quantity: 2 }]));

  /*
   * An item that was never priced.
   *
   * Caught by the FINGERPRINT, not by the per-line lookup -- an extra item is a different
   * basket, and the fingerprint sees that before any line is read. The per-line guard inside
   * createFullOrder stays as a second wall: it is what would catch a quote whose stored result
   * had somehow lost a line, and it costs nothing.
   */
  const missing: any = await quoteFor([{ variantId: V.saree, quantity: 1 }]);
  await refuses('an item that was never priced is refused', 'has changed',
    () => salesOrderService.createFullOrder(CLIENT, locationId, {
      customer: { id: customerId },
      quoteId: missing.quoteId,
      items: [{ variantId: V.saree, quantity: 1 }, { variantId: V.blouse, quantity: 1 }]
    }));

  const expired: any = await quoteFor([{ variantId: V.saree, quantity: 1 }]);
  await prisma.pricingQuote.update({
    where: { id: expired.quoteId }, data: { expiresAt: new Date(Date.now() - 1000) }
  });
  await refuses('an expired quote is refused', 'expired',
    () => orderFrom(expired, [{ variantId: V.saree, quantity: 1 }]));

  // ── D. THE ALLOWANCE IS ACTUALLY SPENT ─────────────────────────────────
  console.log('\nD. AN OFFER RUNS OUT WHEN IT SAID IT WOULD');

  const beforeCount = (await prisma.offer.findUniqueOrThrow({ where: { id: twenty.id } })).usageCount;
  check('every order so far counted as one use', beforeCount === 2, String(beforeCount));

  const redemptions = await prisma.offerRedemption.findMany({ where: { salesOrderId: order.id } });
  check('the redemption is recorded once for the order', redemptions.length === 1, String(redemptions.length));
  check('  ...for what it saved', num(redemptions[0]?.amount) === 4960, String(redemptions[0]?.amount));
  check('  ...as COUNTED', redemptions[0]?.status === 'COUNTED', redemptions[0]?.status);
  check('  ...against the customer, so a per-person limit can be counted',
    redemptions[0]?.customerId === customerId);

  const onceOnly = await liveOffer({
    name: 'First one only', value: 50, usageLimit: 1, stackable: true, level: 'ORDER'
  });
  const firstQuote: any = await quoteFor([{ variantId: V.blouse, quantity: 1 }]);
  await orderFrom(firstQuote, [{ variantId: V.blouse, quantity: 1 }]);
  check('the limited offer is now spent',
    (await prisma.offer.findUniqueOrThrow({ where: { id: onceOnly.id } })).usageCount === 1);

  const secondQuote: any = await quoteFor([{ variantId: V.blouse, quantity: 1 }]);
  check('a spent offer is no longer quoted',
    !secondQuote.discounts.some((d: any) => d.offerId === onceOnly.id),
    JSON.stringify(secondQuote.discounts.map((d: any) => d.title)));

  /*
   * The race, made deterministic.
   *
   * Two checkouts quoted while the offer still had room, both ordering afterwards. Quoting is
   * where the limit LOOKS available; spending it is where it has to be decided. Only one of
   * these may succeed, and the other must leave nothing behind.
   */
  const raceOffer = await liveOffer({
    name: 'Only one of these', value: 100, valueType: 'FIXED_AMOUNT',
    usageLimit: 1, stackable: true, level: 'ORDER'
  });
  const raceA: any = await quoteFor([{ variantId: V.blouse, quantity: 2 }]);
  const raceB: any = await quoteFor([{ variantId: V.blouse, quantity: 2 }]);
  check('both were quoted the offer while it had room',
    raceA.discounts.some((d: any) => d.offerId === raceOffer.id) &&
    raceB.discounts.some((d: any) => d.offerId === raceOffer.id));

  const ordersBefore = await prisma.salesOrder.count({ where: { clientId: CLIENT } });
  const results = await Promise.allSettled([
    orderFrom(raceA, [{ variantId: V.blouse, quantity: 2 }]),
    orderFrom(raceB, [{ variantId: V.blouse, quantity: 2 }])
  ]);
  const won = results.filter(r => r.status === 'fulfilled').length;
  check('exactly one of two simultaneous checkouts gets it', won === 1,
    `${won} succeeded: ${results.map(r => r.status === 'rejected' ? String((r.reason as any)?.message) : 'ok').join(' | ')}`);
  check('  ...and the offer counted exactly one use',
    (await prisma.offer.findUniqueOrThrow({ where: { id: raceOffer.id } })).usageCount === 1);
  check('  ...and the refused checkout left no half-written order',
    (await prisma.salesOrder.count({ where: { clientId: CLIENT } })) === ordersBefore + 1);

  // ── E. GIVING THE ALLOWANCE BACK ───────────────────────────────────────
  console.log('\nE. A CANCELLED ORDER GIVES THE ALLOWANCE BACK. A SHIPPED ONE DOES NOT');

  const backOffer = await liveOffer({
    name: 'Give it back', value: 50, valueType: 'FIXED_AMOUNT',
    usageLimit: 5, stackable: true, level: 'ORDER'
  });
  const cancelQuote: any = await quoteFor([{ variantId: V.blouse, quantity: 1 }]);
  const cancelOrder: any = await orderFrom(cancelQuote, [{ variantId: V.blouse, quantity: 1 }], {
    status: 'CONFIRMED'
  });
  check('confirming spent a use',
    (await prisma.offer.findUniqueOrThrow({ where: { id: backOffer.id } })).usageCount === 1);

  await salesOrderService.cancelOrder(CLIENT, cancelOrder.id);
  check('cancelling before dispatch gives the use back',
    (await prisma.offer.findUniqueOrThrow({ where: { id: backOffer.id } })).usageCount === 0);
  check('  ...and the redemption says RELEASED rather than vanishing',
    (await prisma.offerRedemption.findFirst({ where: { salesOrderId: cancelOrder.id } }))?.status === 'RELEASED');

  // Cancelling twice must not give it back twice, or an offer never runs out at all.
  await salesOrderService.cancelOrder(CLIENT, cancelOrder.id).catch(() => {});
  check('cancelling twice does not give it back twice',
    (await prisma.offer.findUniqueOrThrow({ where: { id: backOffer.id } })).usageCount === 0);

  // ── F. PER-CUSTOMER LIMITS ─────────────────────────────────────────────
  console.log('\nF. ONE PER CUSTOMER MEANS ONE PER CUSTOMER');

  const perPerson = await liveOffer({
    name: 'One each', value: 25, valueType: 'FIXED_AMOUNT',
    usageLimitPerCustomer: 1, stackable: true, level: 'ORDER'
  });

  const mineQ: any = await quoteFor([{ variantId: V.blouse, quantity: 1 }], { customerId });
  await orderFrom(mineQ, [{ variantId: V.blouse, quantity: 1 }]);

  const againQ: any = await quoteFor([{ variantId: V.blouse, quantity: 1 }], { customerId });
  check('the same customer is not offered it a second time',
    !againQ.discounts.some((d: any) => d.offerId === perPerson.id));

  const otherQ: any = await quoteFor([{ variantId: V.blouse, quantity: 1 }], { customerId: otherCustomerId });
  check('a different customer still gets it',
    otherQ.discounts.some((d: any) => d.offerId === perPerson.id));

  const guestQ: any = await quoteFor([{ variantId: V.blouse, quantity: 1 }]);
  check('a guest is not given a per-person offer at all',
    !guestQ.discounts.some((d: any) => d.offerId === perPerson.id));

  // ── G. A PERSON TAKING MONEY OFF ───────────────────────────────────────
  console.log('\nG. THE TILL OVERRIDE, AND THE REASON THAT HAS TO COME WITH IT');

  await offerService.setStatus(CLIENT, twenty.id, 'PAUSED', USER);
  await offerService.setStatus(CLIENT, perPerson.id, 'PAUSED', USER);
  await offerService.setStatus(CLIENT, backOffer.id, 'PAUSED', USER);

  const manualOrder: any = await salesOrderService.createFullOrder(CLIENT, locationId, {
    customer: { id: customerId },
    items: [{ variantId: V.saree, quantity: 1, manualDiscount: { amount: 500, reason: 'Small mark on the pallu' } }]
  });
  const manualItem = await prisma.salesOrderItem.findFirstOrThrow({
    where: { salesOrderId: manualOrder.id }
  });
  check('the money comes off the line', num(manualItem.totalPrice) === 11500, String(manualItem.totalPrice));
  check('  ...and the line says a person decided it', manualItem.priceSource === 'MANUAL', manualItem.priceSource);
  check('  ...and the order total agrees', num(manualOrder.total) === 11500, String(manualOrder.total));

  const manualRow = await prisma.salesOrderDiscount.findFirstOrThrow({
    where: { salesOrderId: manualOrder.id }, include: { allocations: true }
  });
  check('the reason is kept, as the discount itself',
    manualRow.title === 'Small mark on the pallu', manualRow.title);
  check('  ...marked MANUAL, so a report can tell it from an offer',
    manualRow.source === 'MANUAL', manualRow.source);
  check('  ...with no offer behind it', manualRow.offerId === null);
  check('  ...allocated to the line it came off', manualRow.allocations.length === 1 &&
    num(manualRow.allocations[0].amount) === 500);

  await refuses('a manual discount with no reason is refused', 'say why',
    () => salesOrderService.createFullOrder(CLIENT, locationId, {
      customer: { id: customerId },
      items: [{ variantId: V.saree, quantity: 1, manualDiscount: { amount: 500 } }]
    }));

  await refuses('"na" is not a reason', 'does not say why',
    () => salesOrderService.createFullOrder(CLIENT, locationId, {
      customer: { id: customerId },
      items: [{ variantId: V.saree, quantity: 1, manualDiscount: { amount: 500, reason: 'na' } }]
    }));

  await refuses('a reason of one character is not a reason', 'does not say why',
    () => salesOrderService.createFullOrder(CLIENT, locationId, {
      customer: { id: customerId },
      items: [{ variantId: V.saree, quantity: 1, manualDiscount: { amount: 500, reason: 'x' } }]
    }));

  await refuses('taking off more than the line is worth is refused', 'less than nothing',
    () => salesOrderService.createFullOrder(CLIENT, locationId, {
      customer: { id: customerId },
      items: [{ variantId: V.saree, quantity: 1, manualDiscount: { amount: 99999, reason: 'Manager approved this' } }]
    }));

  await refuses('a discount of nothing is refused', 'more than nothing',
    () => salesOrderService.createFullOrder(CLIENT, locationId, {
      customer: { id: customerId },
      items: [{ variantId: V.saree, quantity: 1, manualDiscount: { amount: 0, reason: 'Manager approved this' } }]
    }));

  // ── H. A MANUAL DISCOUNT ON THE WHOLE BILL ─────────────────────────────
  console.log('\nH. MONEY OFF THE WHOLE BILL, DIVIDED BETWEEN THE LINES');

  const billOrder: any = await salesOrderService.createFullOrder(CLIENT, locationId, {
    customer: { id: customerId },
    manualDiscount: { amount: 1000, reason: 'Long-standing customer, owner approved' },
    items: [{ variantId: V.saree, quantity: 1 }, { variantId: V.blouse, quantity: 1 }]
  });
  const billItems = await prisma.salesOrderItem.findMany({ where: { salesOrderId: billOrder.id } });
  const billShare = billItems.reduce((s, i) => s + num(i.allocatedDiscount), 0);
  check('the whole discount is divided between the lines', billShare === 1000, String(billShare));
  check('  ...weighted by what each line is worth',
    num(billItems.find(i => i.variantId === V.saree)!.allocatedDiscount) >
    num(billItems.find(i => i.variantId === V.blouse)!.allocatedDiscount));
  check('the bill total is right', num(billOrder.total) === 11800, String(billOrder.total));

  const billRow = await prisma.salesOrderDiscount.findFirstOrThrow({
    where: { salesOrderId: billOrder.id }, include: { allocations: true }
  });
  check('the reason reaches the order', billRow.title.includes('owner approved'), billRow.title);
  const billAllocated = billRow.allocations.reduce((s, a) => s + num(a.amount), 0);
  check('  ...and its allocations add up to it exactly', billAllocated === 1000, String(billAllocated));

  await refuses('a bill discount and a manual one together is refused', 'not both',
    () => salesOrderService.createFullOrder(CLIENT, locationId, {
      customer: { id: customerId },
      discountAmount: 500,
      manualDiscount: { amount: 500, reason: 'Owner approved this one' },
      items: [{ variantId: V.saree, quantity: 1 }]
    }));

  // ── I. AN OFFER AND A HAND-WRITTEN DISCOUNT TOGETHER ────────────────────
  console.log('\nI. AN OFFER AND A GOODWILL GESTURE ARE TWO SEPARATE DECISIONS');

  await offerService.setStatus(CLIENT, twenty.id, 'ACTIVE', USER);
  const bothQuote: any = await quoteFor([{ variantId: V.saree, quantity: 1 }]);
  const bothOrder: any = await salesOrderService.createFullOrder(CLIENT, locationId, {
    customer: { id: customerId },
    quoteId: bothQuote.quoteId,
    items: [{
      variantId: V.saree, quantity: 1,
      manualDiscount: { amount: 600, reason: 'Loose thread, customer noticed' }
    }]
  });
  check('the offer and the override both apply', num(bothOrder.total) === 9000, String(bothOrder.total));

  const bothRows = await prisma.salesOrderDiscount.findMany({
    where: { salesOrderId: bothOrder.id }, orderBy: { createdAt: 'asc' }
  });
  check('  ...and are recorded as two separate things', bothRows.length === 2, String(bothRows.length));
  check('  ...one an offer, one a person',
    bothRows.some(r => r.source === 'OFFER') && bothRows.some(r => r.source === 'MANUAL'));

  const bothItem = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: bothOrder.id } });
  check('the line shows the whole reduction', num(bothItem.lineDiscount) === 3000, String(bothItem.lineDiscount));
  check('  ...and says a person had the final say on it',
    bothItem.priceSource === 'MANUAL', bothItem.priceSource);

  // ── J. NOTHING BROKE FOR ORDERS THAT USE NONE OF THIS ───────────────────
  console.log('\nJ. AN ORDINARY ORDER IS UNCHANGED');

  const plain: any = await salesOrderService.createFullOrder(CLIENT, locationId, {
    customer: { id: customerId },
    items: [{ variantId: V.blouse, quantity: 3, unitPrice: 700 }]
  });
  const plainItem = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: plain.id } });
  check('a caller-priced order still works', num(plain.total) === 2100, String(plain.total));
  check('  ...and is still marked EXTERNAL', plainItem.priceSource === 'EXTERNAL', plainItem.priceSource);
  check('  ...and carries no discount rows',
    (await prisma.salesOrderDiscount.count({ where: { salesOrderId: plain.id } })) === 0);

  const catalogue: any = await salesOrderService.createFullOrder(CLIENT, locationId, {
    customer: { id: customerId },
    items: [{ variantId: V.blouse, quantity: 1 }]
  });
  const catalogueItem = await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: catalogue.id } });
  check('an order with no prices at all is still priced from the catalogue',
    catalogueItem.priceSource === 'CATALOGUE' && num(catalogue.total) === 800,
    `${catalogueItem.priceSource} / ${catalogue.total}`);

  // ── K. THE BOOKS BALANCE ───────────────────────────────────────────────
  console.log('\nK. EVERY ORDER IN THIS TENANT ADDS UP');

  const allOrders = await prisma.salesOrder.findMany({
    where: { clientId: CLIENT }, include: { items: true, discounts: { include: { allocations: true } } }
  });
  check('every order total equals its lines',
    allOrders.every(o =>
      Math.abs(o.items.reduce((s, i) => s + num(i.totalPrice), 0) - num(o.total)) < 0.005),
    String(allOrders.length));
  check('every discount row is fully allocated to lines',
    allOrders.every(o => o.discounts.every(d =>
      Math.abs(d.allocations.reduce((s, a) => s + num(a.amount), 0) - num(d.amount)) < 0.005)));
  check('no line was sold for less than nothing',
    allOrders.every(o => o.items.every(i => num(i.totalPrice) >= 0)));
  check('every quote that was used points at the order that used it',
    (await prisma.pricingQuote.findMany({ where: { clientId: CLIENT, consumedAt: { not: null } } }))
      .every(q => !!q.salesOrderId));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.salesOrderItemDiscount.deleteMany({
      where: { salesOrderDiscount: { salesOrder: { clientId: CLIENT } } }
    });
    await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.inventoryReservation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: CLIENT } } });
    await prisma.salesOrder.deleteMany({ where: { clientId: CLIENT } });
    await prisma.pricingQuote.deleteMany({ where: { clientId: CLIENT } });
    await prisma.offerRedemption.deleteMany({ where: { clientId: CLIENT } });
    await prisma.offerVersion.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offerTarget.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } });
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } });
    await prisma.product.deleteMany({ where: { clientId: CLIENT } });
    await prisma.customer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
