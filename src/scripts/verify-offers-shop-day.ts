/**
 * A day at the shop with six offers running at once, read back the way the shop reads it.
 *
 * Every other offer suite looks at what a CUSTOMER is charged. This looks at what the SHOP then
 * sees, on every screen that shows money, because a discount that prices correctly and reports
 * wrongly is still a wrong discount -- the owner closes the day on the day book, not the quote:
 *
 *   the till's price breakdown  what came off each line, and why
 *   the order page              list price, line discount, bill share, net -- all adding up
 *   the orders list             the net total, not the tag
 *   the customer page           the same totals
 *   the day book                revenue and profit at what was PAID, cost at what stock COST
 *   stock value                 falls by cost, never by selling price or discount
 *   the website                 badges for what a shopper can get; catalogue prices untouched
 *   the offer pages             times used and discount given, reconciling to the orders
 *   a return                    refund owed = what that piece actually cost the customer
 *   a cancelled order           in no total anywhere, and its uses given back
 *
 * Offers running together: 20% off sarees; 100 off each blouse; 500 off bills over 5,000 except
 * bridal (combines); VIP 5% extra (combines); a happy hour on lehengas that is open right now;
 * single-use 300-off cards (combine). Plus a till limit of 10% by hand.
 *
 * Throwaway tenant. Needs the API running.
 *
 *   npx tsx src/scripts/verify-offers-shop-day.ts
 */
import axios, { AxiosInstance } from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { generateCredential } from '../utils/storefrontCredential';
import { todayKey } from '../utils/businessDay';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const STAMP = Date.now();
const CLIENT = `shopday-${STAMP}`;
const num = (v: any) => Number(v ?? 0);
const near = (a: any, b: any) => Math.abs(num(a) - num(b)) < 0.005;
const un = (r: any) => (r?.data?.data !== undefined ? r.data.data : r?.data);
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 240)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function person(role: string, roleIds: Record<string, string>): Promise<AxiosInstance> {
  const user = await prisma.user.create({ data: { clientId: CLIENT, email: `${role.toLowerCase()}-${STAMP}@example.com`, name: role, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleIds[role] } });
  const token = jwt.sign({ sub: user.id, clientId: CLIENT, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}

/** An hour either side of now, on the shop's clock. */
function openWindow() {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number);
  const at = (mins: number) => { const x = ((mins % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  return { from: at(h * 60 + m - 60), to: at(h * 60 + m + 60) };
}

async function main() {
  console.log(`SETUP: a shop from the real role templates, stock with costs, two customers  (${BASE})`);
  const roleIds = await seedRolesForClient(CLIENT);
  const owner = await person('SUPER_ADMIN', roleIds);
  const sales = await person('SALES', roleIds);
  const warehouse = await person('WAREHOUSE', roleIds);

  const shop = (await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } })).id;
  const V: Record<string, { id: string; code: string; product: string; productCode: string }> = {};
  for (const [key, title, dressType, price, cost, qty] of [
    ['silk', 'Silk Saree', 'Saree', 10000, 6000, 10],
    ['cotton', 'Cotton Saree', 'Saree', 2000, 900, 10],
    ['blouse', 'Ready Blouse', 'Blouse', 800, 300, 10],
    ['lehenga', 'Bridal Lehenga', 'Lehenga', 25000, 15000, 3]
  ] as const) {
    const p = await prisma.product.create({ data: { clientId: CLIENT, productCode: `P-${key}-${STAMP}`, title, slug: `${key}-${STAMP}`, category: 'WOMEN', dressType, basePrice: price, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
    const v = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: p.id, sku: `SKU-${key}-${STAMP}`, variantCode: `VC-${key}-${STAMP}`, size: 'Free', colorName: 'Red', sellingPrice: price } });
    await inventoryMutationService.applyMovement({ clientId: CLIENT, variantId: v.id, locationId: shop, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: qty, unitCost: cost });
    V[key] = { id: v.id, code: v.variantCode, product: p.id, productCode: p.productCode };
  }
  const meena = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'C1', name: 'Meena', status: 'ACTIVE', tags: ['VIP'] } })).id;
  const cred = generateCredential();
  await prisma.storefrontConnection.create({ data: { clientId: CLIENT, name: 'Website', status: 'ACTIVE', baseUrl: 'https://example.invalid', credentialHash: cred.hash, credentialPrefix: cred.prefix, locationIds: [shop] } });
  const website = (path: string, body?: any) => axios.request({ url: `${BASE}/storefront/v1${path}`, method: body ? 'POST' : 'GET', data: body, headers: { 'X-Storefront-Key': cred.plaintext }, validateStatus: () => true });

  const valueBefore = un(await owner.get('/reports/inventory-value'));

  // ── THE OFFERS, WRITTEN AND STARTED THROUGH THE SCREENS' API ──────────
  console.log('\nTHE OWNER STARTS SIX OFFERS');
  const start = new Date(Date.now() - 3600_000).toISOString();
  const make = async (body: any) => {
    const r = await owner.post('/offers', { startsAt: start, ...body });
    check(`"${body.name}" is written`, r.status === 201, brief(r));
    const id = un(r)?.id;
    if (body.uniqueCodes) {
      const c = await owner.post(`/offers/${id}/codes`, { prefix: 'WELCOME', count: 5 });
      check('  ...its cards are made', c.status === 201, brief(c));
    }
    const s = await owner.post(`/offers/${id}/status`, { status: 'ACTIVE' });
    check('  ...and started', s.status === 200, brief(s));
    return id;
  };
  const O = {
    sarees: await make({ name: 'Saree week', valueType: 'PERCENTAGE', value: 20, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Saree' }] }),
    blouses: await make({ name: '100 off each blouse', valueType: 'FIXED_AMOUNT', value: 100, perPiece: true, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Blouse' }] }),
    bigBill: await make({ name: 'Big bill 500', level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 500, minSubtotal: 5000, stackable: true, exclusions: [{ scope: 'DRESS_TYPE', refId: 'Lehenga' }] }),
    vip: await make({ name: 'VIP extra 5%', valueType: 'PERCENTAGE', value: 5, stackable: true, customerTags: ['VIP'] }),
    happy: await make({ name: 'Lehenga happy hour', valueType: 'PERCENTAGE', value: 10, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Lehenga' }], schedule: openWindow() }),
    cards: await make({ name: 'Welcome card', trigger: 'CODE', uniqueCodes: true, level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 300, stackable: true })
  };
  const put = await owner.put('/offers/settings', { manualDiscountMaxPercent: 10 });
  check('the owner sets a 10% till limit', put.status === 200, brief(put));
  const cards = (un(await owner.get(`/offers/${O.cards}/codes`, { params: { status: 'UNUSED' } }))?.codes ?? []).map((c: any) => c.code);

  // ── THE WEBSITE BEFORE ANYONE BUYS ─────────────────────────────────────
  console.log('\nWHAT THE WEBSITE SHOWS');
  const badges = (un(await website('/offers'))?.offers ?? []).map((o: any) => o.name).sort();
  check('badges: sarees, blouses, the big bill and the happy hour -- not VIP, not the cards', JSON.stringify(badges) === JSON.stringify(['100 off each blouse', 'Big bill 500', 'Lehenga happy hour', 'Saree week']), JSON.stringify(badges));
  const catalogue = un(await website('/products'));
  const listed = JSON.stringify(catalogue ?? {});
  check('the catalogue still lists the silk saree at 10,000 -- offers never rewrite a price', /10000/.test(listed) && !/8000(\.0+)?[,}]/.test(listed), listed.slice(0, 300));

  // ── ORDER 1: MEENA AT THE TILL ─────────────────────────────────────────
  console.log('\nORDER 1: MEENA (VIP) BUYS TWO COTTON SAREES AND THREE BLOUSES AT THE TILL');
  const lines1 = [{ variantId: V.cotton.id, quantity: 2 }, { variantId: V.blouse.id, quantity: 3 }];
  const q1 = un(await sales.post('/pricing/quote', { locationId: shop, customerId: meena, lines: lines1 }));
  // cotton 4,000 - 20% (800) - VIP 5% of 3,200 (160) = 3,040
  // blouse 2,400 - 100 x 3 (300) - VIP 5% of 2,100 (105) = 1,995
  // 5,035 is over 5,000: 500 off the bill = 4,535
  check('the till prices it at 4,535', q1?.total === 4535, JSON.stringify({ total: q1?.total, discounts: q1?.discounts?.map((d: any) => [d.title, d.amount]) }));
  const cot = q1?.lines?.find((l: any) => l.variantId === V.cotton.id);
  check('  ...and shows the cashier why, line by line', ['Saree week', 'VIP extra 5%', 'Big bill 500'].every(t => cot?.appliedOffers?.some((a: any) => a.title === t)), JSON.stringify(cot?.appliedOffers?.map((a: any) => a.title)));
  check('  ...with the offers adding up to the discount', near(q1?.discounts?.reduce((s: number, d: any) => s + d.amount, 0), q1?.discountTotal));
  const o1r = await sales.post('/sales-orders/full', { customer: { id: meena }, locationId: shop, quoteId: q1.quoteId, items: lines1, status: 'CONFIRMED' });
  check('the order is taken, confirmed', o1r.status === 201, brief(o1r));
  const o1 = un(o1r);

  // ── ORDER 2: A WEBSITE SHOPPER WITH A CARD ─────────────────────────────
  console.log('\nORDER 2: A SHOPPER ON THE WEBSITE BUYS A LEHENGA AND A SILK SAREE WITH A WELCOME CARD');
  const q2 = un(await website('/pricing/quote', { lines: [{ variantCode: V.lehenga.code, quantity: 1 }, { variantCode: V.silk.code, quantity: 1 }], couponCodes: [cards[0]] }));
  // lehenga 25,000 - happy hour 10% = 22,500 (excluded from the big bill)
  // silk 10,000 - 20% = 8,000; 8,000 is over 5,000 -> 500 off it = 7,500
  // card 300 off the whole bill (combines) = 30,000 - 300 = 29,700
  check('the website prices it at 29,700', q2?.total === 29700, JSON.stringify({ total: q2?.total, discounts: q2?.discounts?.map((d: any) => [d.title, d.amount]), rejected: q2?.rejected }));
  const leh = q2?.lines?.find((l: any) => l.variantId === V.lehenga.id);
  check('  ...the lehenga takes no share of the big-bill 500', !leh?.appliedOffers?.some((a: any) => a.title === 'Big bill 500'), JSON.stringify(leh?.appliedOffers));
  const o2r = await sales.post('/sales-orders/full', {
    customer: { externalId: `web-${STAMP}`, name: 'Anitha' }, locationId: shop, channel: 'ONLINE', quoteId: q2.quoteId, couponCodes: [cards[0]],
    items: [{ variantId: V.lehenga.id, quantity: 1 }, { variantId: V.silk.id, quantity: 1 }], status: 'CONFIRMED', externalOrderId: `W-${STAMP}`, sourceSystem: 'website'
  });
  check('the website order is placed', o2r.status === 201, brief(o2r));
  const o2 = un(o2r);

  // ── ORDER 3: A TILL DISCOUNT BY HAND ───────────────────────────────────
  console.log('\nORDER 3: A COTTON SAREE WITH A PULLED THREAD -- 150 OFF BY HAND');
  const q3 = un(await sales.post('/pricing/quote', { locationId: shop, lines: [{ variantId: V.cotton.id, quantity: 1 }] }));
  const over = await sales.post('/sales-orders/full', { customer: { externalId: `walkin-${STAMP}`, name: 'Walk-in' }, locationId: shop, quoteId: q3.quoteId, items: [{ variantId: V.cotton.id, quantity: 1, manualDiscount: { amount: 400, reason: 'Pulled thread on the border' } }] });
  check('400 off a 1,600 saree (25%) by a salesperson is refused', over.status === 403, brief(over));
  const q3b = un(await sales.post('/pricing/quote', { locationId: shop, lines: [{ variantId: V.cotton.id, quantity: 1 }] }));
  const o3r = await sales.post('/sales-orders/full', { customer: { externalId: `walkin-${STAMP}`, name: 'Walk-in' }, locationId: shop, quoteId: q3b.quoteId, items: [{ variantId: V.cotton.id, quantity: 1, manualDiscount: { amount: 150, reason: 'Pulled thread on the border' } }], status: 'CONFIRMED' });
  check('150 off (9.4%) is taken, on top of the 20%: 1,450', o3r.status === 201 && num(un(o3r)?.total) === 1450, brief(o3r));
  const o3 = un(o3r);

  // ── ORDER 4: CANCELLED ─────────────────────────────────────────────────
  console.log('\nORDER 4: MEENA ORDERS A SILK SAREE, THEN CANCELS');
  const q4 = un(await sales.post('/pricing/quote', { locationId: shop, customerId: meena, lines: [{ variantId: V.silk.id, quantity: 1 }] }));
  const o4 = un(await sales.post('/sales-orders/full', { customer: { id: meena }, locationId: shop, quoteId: q4.quoteId, items: [{ variantId: V.silk.id, quantity: 1 }], status: 'CONFIRMED' }));
  const cancel = await owner.post(`/sales-orders/${o4?.id}/cancel`);
  check('it is cancelled', cancel.status === 200, brief(cancel));

  await sleep(8000);

  // ── THE ORDER PAGE ─────────────────────────────────────────────────────
  console.log('\nTHE ORDER PAGE ADDS UP');
  for (const [label, o] of [['order 1', o1], ['order 2', o2], ['order 3', o3]] as const) {
    const d = un(await owner.get(`/sales-orders/${o.id}`));
    const itemsNet = d.items.reduce((s: number, i: any) => s + num(i.totalPrice), 0);
    const itemsList = d.items.reduce((s: number, i: any) => s + num(i.listUnitPrice) * i.quantity, 0);
    const rowsTotal = d.discounts.reduce((s: number, r: any) => s + num(r.amount), 0);
    check(`${label}: the lines add up to the total`, near(itemsNet, d.total), `${itemsNet} vs ${d.total}`);
    check(`${label}: list price less every discount row is the total`, near(itemsList - rowsTotal, d.total), `${itemsList} - ${rowsTotal} vs ${d.total}`);
    check(`${label}: each discount row's allocations add up to it`, d.discounts.every((r: any) => near(r.allocations.reduce((s: number, a: any) => s + num(a.amount), 0), r.amount)), JSON.stringify(d.discounts.map((r: any) => [r.title, r.amount])));
    check(`${label}: every line's list less discounts is its price`, d.items.every((i: any) => near(num(i.listUnitPrice) * i.quantity - num(i.lineDiscount) - num(i.allocatedDiscount), i.totalPrice)), JSON.stringify(d.items.map((i: any) => [i.listUnitPrice, i.quantity, i.lineDiscount, i.allocatedDiscount, i.totalPrice])));
    check(`${label}: profit is against what was paid`, d.items.every((i: any) => near(num(i.grossProfit), num(i.totalPrice) - num(i.totalCost))));
  }
  const d2 = un(await owner.get(`/sales-orders/${o2.id}`));
  check('order 2 says which card was spent', d2.discounts.some((r: any) => r.code === cards[0] && r.title === 'Welcome card'), JSON.stringify(d2.discounts.map((r: any) => [r.title, r.code])));
  check('  ...and that it came from the website', d2.channel === 'ONLINE');
  const d3 = un(await owner.get(`/sales-orders/${o3.id}`));
  check('order 3 records the reason and who took the 150 off', d3.discounts.some((r: any) => r.source === 'MANUAL' && r.title === 'Pulled thread on the border' && !!r.appliedBy), JSON.stringify(d3.discounts));

  // ── LISTS AND THE CUSTOMER PAGE ────────────────────────────────────────
  console.log('\nTHE ORDERS LIST AND THE CUSTOMER PAGE');
  const list = un(await owner.get('/sales-orders')) ?? [];
  const totalOf = (id: string) => num(list.find((o: any) => o.id === id)?.total);
  check('the orders list shows net totals: 4,535 / 29,700 / 1,450', totalOf(o1.id) === 4535 && totalOf(o2.id) === 29700 && totalOf(o3.id) === 1450, JSON.stringify(list.map((o: any) => [o.orderNumber, o.total, o.status])));
  check('  ...and the cancelled order as cancelled', list.find((o: any) => o.id === o4.id)?.status === 'CANCELLED');
  const cust = un(await owner.get(`/customers/${meena}`));
  check("Meena's page shows her orders at what she paid", num(cust?.salesOrders?.find((o: any) => o.id === o1.id)?.total) === 4535, JSON.stringify(cust?.salesOrders?.map((o: any) => [o.orderNumber, o.total])));

  // ── SHIPPING, THE DAY BOOK AND STOCK VALUE ─────────────────────────────
  console.log('\nTHE WAREHOUSE SHIPS; THE DAY BOOK AND STOCK VALUE FOLLOW');
  for (const o of [o1, o2, o3]) {
    const d = un(await owner.get(`/sales-orders/${o.id}`));
    const r = await warehouse.post('/dispatches', { salesOrderId: o.id, items: d.items.map((i: any) => ({ salesOrderItemId: i.id, quantity: i.quantity })) });
    check(`${d.orderNumber} is shipped`, r.status === 201, brief(r));
  }
  await sleep(4000);
  const book = un(await owner.get('/daybook', { params: { date: todayKey('Asia/Kolkata') } }));
  const revenue = 4535 + 29700 + 1450;
  const cogs = (2 * 900 + 3 * 300) + (15000 + 6000) + 900;
  check(`the day book's revenue is what customers paid: ${revenue}`, near(book?.sales?.revenue, revenue), JSON.stringify(book?.sales && { r: book.sales.revenue, c: book.sales.costOfGoods }));
  check(`  ...cost of goods is what the stock cost: ${cogs}`, near(book?.sales?.costOfGoods, cogs), String(book?.sales?.costOfGoods));
  check(`  ...profit is the difference: ${revenue - cogs}`, near(book?.sales?.grossProfit, revenue - cogs), String(book?.sales?.grossProfit));
  check('  ...three orders, the cancelled one nowhere', book?.sales?.dispatchCount === 3 && !(book?.sales?.orders ?? []).some((r: any) => r.orderNumber === o4.orderNumber), JSON.stringify(book?.sales?.orders?.map((r: any) => r.orderNumber)));
  check('  ...each order row at its net value', (book?.sales?.orders ?? []).every((r: any) => [4535, 29700, 1450].some(v => near(r.value, v))), JSON.stringify(book?.sales?.orders?.map((r: any) => r.value)));
  const valueAfter = un(await owner.get('/reports/inventory-value'));
  check(`stock value falls by what the stock cost (${cogs}), not by what it sold for`, near(num(valueBefore?.totalValue) - num(valueAfter?.totalValue), cogs), `${valueBefore?.totalValue} -> ${valueAfter?.totalValue}`);

  // ── THE OFFER PAGES ────────────────────────────────────────────────────
  console.log('\nTHE OFFER PAGES RECONCILE TO THE ORDERS');
  const stats = async (id: string) => un(await owner.get(`/offers/${id}`))?.stats;
  const s = { sarees: await stats(O.sarees), blouses: await stats(O.blouses), bigBill: await stats(O.bigBill), vip: await stats(O.vip), happy: await stats(O.happy), cards: await stats(O.cards) };
  check('Saree week: 3 uses, 800 + 2,000 + 400 = 3,200 given', s.sarees?.timesUsed === 3 && near(s.sarees?.totalDiscounted, 3200), JSON.stringify(s.sarees));
  check('100 off each blouse: 1 use, 300 given', s.blouses?.timesUsed === 1 && near(s.blouses?.totalDiscounted, 300), JSON.stringify(s.blouses));
  check('Big bill: 2 uses, 1,000 given', s.bigBill?.timesUsed === 2 && near(s.bigBill?.totalDiscounted, 1000), JSON.stringify(s.bigBill));
  check('VIP: 1 use kept (265), 1 given back by the cancelled order', s.vip?.timesUsed === 1 && near(s.vip?.totalDiscounted, 265) && s.vip?.givenBack === 1, JSON.stringify(s.vip));
  check('Happy hour: 1 use, 2,500 given', s.happy?.timesUsed === 1 && near(s.happy?.totalDiscounted, 2500), JSON.stringify(s.happy));
  check('Welcome card: 1 use, 300 given, 1 of 5 cards spent', s.cards?.timesUsed === 1 && near(s.cards?.totalDiscounted, 300) && un(await owner.get(`/offers/${O.cards}`))?.codes?.used === 1, JSON.stringify(s.cards));
  const allGiven = [s.sarees, s.blouses, s.bigBill, s.vip, s.happy, s.cards].reduce((t, x) => t + num(x?.totalDiscounted), 0);
  const allOrders = [o1, o2, o3].reduce((t, o) => t + num(o.discountAmount), 0) - 150;
  check('every offer page together gives away exactly what the orders say came off (less the hand discount)', near(allGiven, allOrders), `${allGiven} vs ${allOrders}`);

  // ── A RETURN ───────────────────────────────────────────────────────────
  console.log('\nMEENA RETURNS ONE BLOUSE');
  const blouseLine = un(await owner.get(`/sales-orders/${o1.id}`)).items.find((i: any) => i.variantId === V.blouse.id);
  const dItem = await prisma.dispatchItem.findFirstOrThrow({ where: { salesOrderItemId: blouseLine.id } });
  const ret = await owner.post('/returns', { salesOrderId: o1.id, items: [{ dispatchItemId: dItem.id, quantity: 1 }], reason: 'SIZE_ISSUE' });
  check('the return is logged', ret.status === 201, brief(ret));
  const retRow = await prisma.salesReturn.findUniqueOrThrow({ where: { id: un(ret).id } });
  const paidEach = Math.round(num(blouseLine.totalPrice) / 3 * 100) / 100;
  check(`it owes ${paidEach} -- what one blouse cost after three offers, not 800`, Math.abs(num(retRow.refundTotal) - paidEach) <= 0.01, `${retRow.refundTotal}`);
  check('  ...and no offer use is given back for a return', (await stats(O.blouses))?.timesUsed === 1);

  await owner.put('/offers/settings', { manualDiscountMaxPercent: null });
}

main()
  .catch(e => { failed++; failures.push(`crashed: ${e?.message ?? e}`); console.error(e); })
  .finally(async () => {
    const c = CLIENT;
    await prisma.inventoryAlert.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.salesReturnItem.deleteMany({ where: { salesReturn: { clientId: c } } });
    await prisma.salesReturn.deleteMany({ where: { clientId: c } });
    await prisma.salesLedger.deleteMany({ where: { clientId: c } });
    await prisma.dispatchItem.deleteMany({ where: { dispatch: { clientId: c } } });
    await prisma.dispatch.deleteMany({ where: { clientId: c } });
    await prisma.salesOrderItemDiscount.deleteMany({ where: { salesOrderItem: { salesOrder: { clientId: c } } } });
    await prisma.salesOrderDiscount.deleteMany({ where: { salesOrder: { clientId: c } } });
    await prisma.inventoryReservation.deleteMany({ where: { clientId: c } });
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: { clientId: c } } });
    await prisma.salesOrder.deleteMany({ where: { clientId: c } });
    await prisma.pricingQuote.deleteMany({ where: { clientId: c } });
    await prisma.offerRedemption.deleteMany({ where: { clientId: c } });
    await prisma.offerCode.deleteMany({ where: { clientId: c } });
    await prisma.offerVersion.deleteMany({ where: { offer: { clientId: c } } });
    await prisma.offer.deleteMany({ where: { clientId: c } });
    await prisma.storefrontDelivery.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.storefrontEvent.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.storefrontConnection.deleteMany({ where: { clientId: c } });
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: c } });
    await prisma.inventoryStock.deleteMany({ where: { clientId: c } });
    await prisma.productVariant.deleteMany({ where: { clientId: c } });
    await prisma.product.deleteMany({ where: { clientId: c } });
    await prisma.customer.deleteMany({ where: { clientId: c } });
    await prisma.stockLocation.deleteMany({ where: { clientId: c } });
    await prisma.userRole.deleteMany({ where: { user: { clientId: c } } });
    await prisma.user.deleteMany({ where: { clientId: c } });
    await prisma.rolePermission.deleteMany({ where: { role: { clientId: c } } });
    await prisma.role.deleteMany({ where: { clientId: c } });
    await prisma.dailyLocationSnapshot.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.dailyInventorySnapshot.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.clientSettings.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.clientSequence.deleteMany({ where: { clientId: c } });
    await prisma.$disconnect();
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
