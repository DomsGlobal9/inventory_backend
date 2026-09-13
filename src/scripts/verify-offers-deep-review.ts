/**
 * Offers: the bugs a line-by-line review of the new code found, each proved fixed.
 *
 *   A  bill offers that do not combine: the same two offers combine or not whatever the bill
 *      comes to; combinable offers apply in a steady order; a code that lost is told why
 *   B  a quote belongs to its customer; junk codes do not crash a quote
 *   C  saving offers: codes that differ only in capitals, switching a live code offer to
 *      single-use codes, junk days, numbers and lists, a copy of an offer whose shop closed
 *   D  till settings said, not assumed; the till limit counted across lines and bill together
 *   E  giving back: a deleted draft frees its card; two cancels at once give one use back
 *   F  a customer created in a group stays in it; codes are only listed to those who may make them
 *
 * Throwaway tenant, deleted at the end. Needs the API running.
 *
 *   npx tsx src/scripts/verify-offers-deep-review.ts
 */
import axios, { AxiosInstance } from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { pricingQuoteService, priceBasket } from '../services/pricing';
import { offerService } from '../services/offers';
import { salesOrderService } from '../services/sales-order.service';
import { customerService } from '../services/customer.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
async function refuses(name: string, fragment: RegExp, fn: () => Promise<any>) {
  try { await fn(); check(name, false, 'it was accepted'); }
  catch (e: any) { check(name, fragment.test(String(e?.message ?? e)), `"${e?.message ?? e}"`); }
}

const STAMP = Date.now();
const CLIENT = `odr-${STAMP}`;
const yesterday = new Date(Date.now() - 86400000);
const un = (r: any) => (r?.data?.data !== undefined ? r.data.data : r?.data);

let shop = '';
const V: Record<string, { id: string; product: string }> = {};
const C: Record<string, string> = {};

async function person(role: string, email: string, roleId: string): Promise<AxiosInstance> {
  const user = await prisma.user.create({ data: { clientId: CLIENT, email, name: role, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId } });
  const token = jwt.sign({ sub: user.id, clientId: CLIENT, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}

const draft = (input: any) => offerService.create(CLIENT, {
  trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE', value: 10, scope: 'ALL', startsAt: yesterday, ...input
} as any, 'owner') as Promise<any>;
const live = async (input: any) => {
  const o = await draft(input);
  if (input.uniqueCodes) await offerService.makeCodes(CLIENT, o.id, 'CARD', input.codeCount ?? 5);
  await offerService.setStatus(CLIENT, o.id, 'ACTIVE', 'owner');
  return o;
};
const pauseAll = async () => {
  for (const o of await prisma.offer.findMany({ where: { clientId: CLIENT, status: 'ACTIVE' } })) await offerService.setStatus(CLIENT, o.id, 'PAUSED', 'owner');
};
const quote = (lines: any[], over: any = {}) => pricingQuoteService.quote(CLIENT, { locationId: shop, channel: 'POS', lines, ...over }) as Promise<any>;
const order = (q: any, lines: any[], over: any = {}) => salesOrderService.createFullOrder(CLIENT, shop, {
  customer: { id: over.customerId ?? C.meena }, quoteId: q?.quoteId ?? null, items: lines, couponCodes: over.couponCodes ?? [], ...(over.data ?? {})
}, 'POS', over.caller) as Promise<any>;

async function product(key: string, dressType: string, price: number) {
  const p = await prisma.product.create({ data: { clientId: CLIENT, productCode: `P-${key}`, title: key, slug: `${key}-${STAMP}`, category: 'WOMEN', dressType, basePrice: price, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  const v = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: p.id, sku: `SKU-${key}-${STAMP}`, variantCode: `VC-${key}-${STAMP}`, size: 'Free', colorName: 'Red', sellingPrice: price } });
  await inventoryMutationService.applyMovement({ clientId: CLIENT, variantId: v.id, locationId: shop, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 100, unitCost: Math.round(price / 2) });
  V[key] = { id: v.id, product: p.id };
}

/** An offer as the engine sees it. */
const engineOffer = (id: string, extra: any) => ({
  id, versionId: null, name: id, trigger: 'AUTOMATIC', couponCode: null, level: 'ORDER', valueType: 'FIXED_AMOUNT',
  value: 100, maxDiscount: null, scope: 'ALL', targets: [], minSubtotalMinor: null, minQuantity: null, priority: 0,
  stackable: false, createdAt: new Date(STAMP), exclusions: [], ...extra
});
const oneLine = (rupees: number) => [{ variantId: 'v', productId: 'p', category: 'WOMEN', quantity: 1, listUnitPriceMinor: rupees * 100 }] as any;

async function main() {
  // ── A. THE ENGINE ──────────────────────────────────────────────────────
  console.log('A. BILL OFFERS THAT DO NOT COMBINE, AND A STEADY ORDER');
  const tenPct = engineOffer('Automatic 10%', { valueType: 'PERCENTAGE', value: 10 });
  const card = engineOffer('Card 300', { value: 300, stackable: true, trigger: 'CODE', couponCode: 'CARD300' });
  const small = priceBasket(oneLine(2900), [tenPct, card] as any, ['CARD300']);
  const big = priceBasket(oneLine(3500), [tenPct, card] as any, ['CARD300']);
  check('2,900 bill: the two do not both apply -- the better one (card, 300) does', small.discountTotalMinor === 30000 && small.discounts.length === 1, JSON.stringify(small.discounts.map(d => [d.title, d.amountMinor])));
  check('3,500 bill: the better one (10%, 350) does', big.discountTotalMinor === 35000 && big.discounts.length === 1, JSON.stringify(big.discounts.map(d => [d.title, d.amountMinor])));
  check('  ...and a smaller bill never gets more off than a bigger one', small.discountTotalMinor <= big.discountTotalMinor);
  check('the card that lost on 3,500 is told why', /do not combine/.test(big.rejected.find(r => r.code === 'CARD300')?.reason ?? ''), JSON.stringify(big.rejected));

  // Two that do combine, and one that does not but is worth less than both together.
  const c200 = engineOffer('Combines 200', { value: 200, stackable: true });
  const c150 = engineOffer('Combines 150', { value: 150, stackable: true });
  const solo300 = engineOffer('Alone 300', { value: 300 });
  const together = priceBasket(oneLine(5000), [solo300, c200, c150] as any);
  check('two combining offers worth 350 together beat one worth 300 alone', together.discountTotalMinor === 35000 && together.discounts.length === 2, JSON.stringify(together.discounts.map(d => d.title)));
  check('  ...and the one alone is told it does not combine', /do not combine/.test(together.nearMisses.find(n => n.title === 'Alone 300')?.reason ?? ''), JSON.stringify(together.nearMisses));
  const priority = priceBasket(oneLine(5000), [engineOffer('Alone 300 first', { value: 300, priority: 5 }), c200, c150] as any);
  check('a higher priority still wins over more money', priority.discountTotalMinor === 30000 && priority.discounts[0].title === 'Alone 300 first', JSON.stringify(priority.discounts.map(d => d.title)));

  const minMissed = priceBasket(oneLine(900), [engineOffer('Over 1000', { value: 100, minSubtotalMinor: 100000 })] as any);
  check('a bill offer short of its minimum still says how much more to spend', /Spend 100.00 more/.test(minMissed.nearMisses[0]?.reason ?? ''), JSON.stringify(minMissed.nearMisses));

  // Line offers that combine, same priority, handed over in either order.
  const pct = engineOffer('10% item', { level: 'LINE', valueType: 'PERCENTAGE', value: 10, stackable: true, createdAt: new Date(STAMP - 1000), id: 'b-pct' });
  const amt = engineOffer('500 item', { level: 'LINE', value: 500, stackable: true, createdAt: new Date(STAMP), id: 'a-amt' });
  const one = priceBasket(oneLine(10000), [pct, amt] as any);
  const two = priceBasket(oneLine(10000), [amt, pct] as any);
  check('combining item offers price the same whatever order the database returns them in', one.discountTotalMinor === two.discountTotalMinor, `${one.discountTotalMinor} vs ${two.discountTotalMinor}`);
  check('  ...older first: 10% of 10,000 then 500 = 1,500', one.discountTotalMinor === 150000, String(one.discountTotalMinor));

  const autoBest = engineOffer('Auto 30% item', { level: 'LINE', valueType: 'PERCENTAGE', value: 30 });
  const codeWorse = engineOffer('Code 10% item', { level: 'LINE', valueType: 'PERCENTAGE', value: 10, trigger: 'CODE', couponCode: 'TEN' });
  const lost = priceBasket(oneLine(1000), [autoBest, codeWorse] as any, ['TEN']);
  check('an item code beaten by a better offer is told so, not "nothing qualifies"', /already takes more off, and the two do not combine/.test(lost.rejected.find(r => r.code === 'TEN')?.reason ?? ''), JSON.stringify(lost.rejected));
  const partly = priceBasket([
    { variantId: 'v1', productId: 'p1', category: 'WOMEN', quantity: 1, listUnitPriceMinor: 100000 },
    { variantId: 'v2', productId: 'p2', category: 'WOMEN', quantity: 1, listUnitPriceMinor: 100000 }
  ] as any, [engineOffer('Auto 30% on p1', { level: 'LINE', valueType: 'PERCENTAGE', value: 30, scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: 'p1' }] }), codeWorse] as any, ['TEN']);
  check('a code that lost on one item but applied on another is neither rejected nor a near miss', partly.rejected.length === 0 && !partly.nearMisses.some(n => n.title === 'Code 10% item'), JSON.stringify({ r: partly.rejected, n: partly.nearMisses }));

  // ── SETUP ──────────────────────────────────────────────────────────────
  console.log(`\nSETUP: a shop, products, customers  (${BASE})`);
  const roleIds = await seedRolesForClient(CLIENT);
  shop = (await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Store', code: 'ST', type: 'STORE', active: true } })).id;
  await product('saree', 'Saree', 10000);
  await product('blouse', 'Blouse', 1000);
  C.meena = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'C1', name: 'Meena', status: 'ACTIVE', tags: ['VIP'] } })).id;
  C.walkin = (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: 'C2', name: 'Walk-in', status: 'ACTIVE' } })).id;
  const cashierRole = await prisma.role.create({ data: { clientId: CLIENT, name: `CASHIER-${STAMP}` } });
  for (const key of ['sales_order:view', 'sales_order:create', 'offer:view']) {
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
    await prisma.rolePermission.create({ data: { roleId: cashierRole.id, permissionId: perm.id } });
  }
  const cashier = await person('CASHIER', `c-${STAMP}@example.com`, cashierRole.id);
  const owner = await person('SUPER_ADMIN', `o-${STAMP}@example.com`, roleIds.SUPER_ADMIN);

  // ── B. A QUOTE BELONGS TO ITS CUSTOMER ─────────────────────────────────
  console.log('\nB. A QUOTE BELONGS TO ITS CUSTOMER');
  const vip = await live({ name: 'VIP 30%', value: 30, customerTags: ['vip'] });
  const sareeLine = [{ variantId: V.saree.id, quantity: 1 }];
  const forMeena = await quote(sareeLine, { customerId: C.meena });
  check('Meena (VIP) is quoted 30% off', forMeena.discountTotal === 3000, String(forMeena.discountTotal));
  await refuses("Meena's VIP price cannot be put on a walk-in's order", /different customer/, () => order(forMeena, sareeLine, { customerId: C.walkin }));
  check('  ...and the refused order left nothing behind', (await prisma.salesOrder.count({ where: { clientId: CLIENT } })) === 0);
  const meenaOrder = await order(forMeena, sareeLine, { customerId: C.meena });
  check('the same quote still works for Meena herself', Number(meenaOrder.discountAmount) === 3000, String(meenaOrder.discountAmount));
  const asGuest = await quote(sareeLine);
  const guestToNamed = await order(asGuest, sareeLine, { customerId: C.walkin });
  check("a guest's quote can go on a named customer's order (it can only be the same price or worse)", !!guestToNamed.id && Number(guestToNamed.discountAmount) === 0);
  await offerService.setStatus(CLIENT, vip.id, 'PAUSED', 'owner');

  const junkCodes = await cashier.post('/pricing/quote', { locationId: shop, lines: sareeLine, couponCodes: [null, 123, 'real', 'REAL'] });
  check('a quote with null and number codes is priced, not crashed', junkCodes.status === 200, `${junkCodes.status} ${JSON.stringify(junkCodes.data).slice(0, 160)}`);
  const dupCodes = await quote(sareeLine, { couponCodes: ['Abc', 'abc'] });
  const sameAsOne = await order(dupCodes, sareeLine, { customerId: C.walkin, couponCodes: ['ABC'] }).then(() => true, e => e?.message);
  check('quoted with ["Abc","abc"], ordered with ["ABC"]: the same codes, not "the basket changed"', sameAsOne === true, String(sameAsOne));

  // ── C. SAVING OFFERS ───────────────────────────────────────────────────
  console.log('\nC. SAVING OFFERS');
  const sale = await live({ name: 'Code SALE', trigger: 'CODE', couponCode: 'SALE', value: 5 });
  await refuses('a second offer with code "sale" is refused -- it would unlock both', /already uses the code SALE/, () => draft({ name: 'Code sale', trigger: 'CODE', couponCode: 'sale' }));
  const other = await draft({ name: 'Code OTHER', trigger: 'CODE', couponCode: 'OTHER' });
  await refuses('  ...and so is changing another offer to "Sale"', /already uses the code SALE/, () => offerService.update(CLIENT, other.id, { couponCode: 'Sale' } as any, 'owner'));
  const recased = await offerService.update(CLIENT, sale.id, { couponCode: 'Sale' } as any, 'owner').then(() => true, e => e?.message);
  check('  ...but an offer may change the capitals of its own code', recased === true, String(recased));

  await refuses('a running offer people hold a code for cannot switch to single-use codes', /switching to single-use codes would stop it working/, () => offerService.update(CLIENT, sale.id, { uniqueCodes: true } as any, 'owner'));
  check('  ...and its code still works', (await quote(sareeLine, { couponCodes: ['sale'] })).discountTotal === 500);
  const draftSwitch = await offerService.update(CLIENT, other.id, { uniqueCodes: true } as any, 'owner').then((o: any) => o.uniqueCodes && o.couponCode == null, e => e?.message);
  check('  ...while a draft nobody has used may switch', draftSwitch === true, String(draftSwitch));
  await pauseAll();

  await refuses('days [0,1,2,3,4,5,9] are refused, not saved as every day', /days of the week/, () => draft({ name: 'Bad days', schedule: { days: [0, 1, 2, 3, 4, 5, 9], from: '10:00', to: '12:00' } }));
  await refuses('seven strings as days are refused', /days of the week/, () => draft({ name: 'String days', schedule: { days: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], from: '10:00', to: '12:00' } }));
  await refuses('days: 5 (not a list) is refused in words', /days of the week/, () => draft({ name: 'Days five', schedule: { days: 5, from: '10:00', to: '12:00' } }));
  const everyDay = await draft({ name: 'Real every day', schedule: { days: [6, 5, 4, 3, 2, 1, 0], from: '10:00', to: '12:00' } });
  check('all seven real days still save as every day', everyDay.schedule && everyDay.schedule.days === undefined, JSON.stringify(everyDay.schedule));
  await refuses('priority 1.5 is refused in words', /Priority has to be a whole number/, () => draft({ name: 'Half priority', priority: 1.5 }));
  await refuses('priority "high" is refused in words', /Priority has to be a whole number/, () => draft({ name: 'High priority', priority: 'high' }));
  const stringPriority = await draft({ name: 'String priority', priority: '3' });
  check('priority "3" is saved as 3', stringPriority.priority === 3, String(stringPriority.priority));
  await refuses('a minimum spend of "abc" is refused in words', /smallest basket has to be an amount/, () => draft({ name: 'Abc minimum', level: 'ORDER', minSubtotal: 'abc' }));
  await refuses('a cap of "abc" is refused in words', /cap has to be more than nothing/, () => draft({ name: 'Abc cap', maxDiscount: 'abc' }));
  await refuses('targets sent as a string are refused in words', /as a list/, () => draft({ name: 'String targets', scope: 'PRODUCT', targets: 'saree' }));
  await refuses('targets containing null are refused in words', /as a list/, () => draft({ name: 'Null targets', scope: 'PRODUCT', targets: [null] }));
  await refuses('channels sent as a string are refused in words', /till, the online store/, () => draft({ name: 'String channels', channels: 'POS' }));

  const branch = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Branch', code: 'BR', type: 'STORE', active: true } });
  const branchOnly = await draft({ name: 'Branch only', locationIds: [branch.id] });
  await prisma.stockLocation.update({ where: { id: branch.id }, data: { active: false } });
  await refuses('copying an offer whose only shop has closed is refused, not widened to every shop', /Every location this offer was for has closed/, () => offerService.duplicate(CLIENT, branchOnly.id, 'owner'));
  check('  ...and no copy was made', (await prisma.offer.count({ where: { clientId: CLIENT, name: 'Copy of Branch only' } })) === 0);

  // ── D. THE TILL ────────────────────────────────────────────────────────
  console.log('\nD. TILL SETTINGS AND THE TILL LIMIT');
  await offerService.setSettings(CLIENT, { manualDiscountMaxPercent: 10 });
  const emptyBody = await owner.put('/offers/settings', {});
  check('saving the till settings with the limit left out is refused, not "no limit"', emptyBody.status === 400, `${emptyBody.status} ${JSON.stringify(emptyBody.data).slice(0, 120)}`);
  const trueBody = await owner.put('/offers/settings', { manualDiscountMaxPercent: true });
  check('a limit of true is refused, not read as 1%', trueBody.status === 400, String(trueBody.status));
  const arrayBody = await owner.put('/offers/settings', { manualDiscountMaxPercent: [50] });
  check('a limit of [50] is refused, not read as 50%', arrayBody.status === 400, String(arrayBody.status));
  check('  ...and the limit is still 10', (await offerService.getSettings(CLIENT)).manualDiscountMaxPercent === 10);

  const till = { userId: 'cashier', mayExceedManualLimit: false };
  const handLines = [
    { variantId: V.saree.id, quantity: 1, manualDiscount: { amount: 1000, reason: 'Loose thread on the border' } },
    { variantId: V.blouse.id, quantity: 1, manualDiscount: { amount: 100, reason: 'Loose thread on the sleeve' } }
  ];
  const tenEach = await order(null, handLines, { customerId: C.walkin, caller: till }).then(() => true, e => e?.message);
  check('10% off each line on a 10% till is allowed', tenEach === true, String(tenEach));
  await refuses('10% off each line and then 10% off the bill is refused -- 19% by hand in all', /this order in all/, () => order(null, handLines, {
    customerId: C.walkin, caller: till, data: { manualDiscount: { amount: 990, reason: 'Regular customer, festival' } }
  }));
  const withinAll = await order(null, [{ ...handLines[0], manualDiscount: { amount: 500, reason: 'Loose thread on the border' } }, { variantId: V.blouse.id, quantity: 1 }], {
    customerId: C.walkin, caller: till, data: { manualDiscount: { amount: 500, reason: 'Regular customer, festival' } }
  }).then(() => true, e => e?.message);
  check('5% on a line plus about 5% on the bill (under 10% in all) is allowed', withinAll === true, String(withinAll));
  await offerService.setSettings(CLIENT, { manualDiscountMaxPercent: null });

  // ── E. GIVING BACK ─────────────────────────────────────────────────────
  console.log('\nE. GIVING BACK');
  const cards = await live({ name: 'Card 500', trigger: 'CODE', uniqueCodes: true, level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 500, usageLimit: 50 });
  const [firstCard] = (await prisma.offerCode.findMany({ where: { offerId: cards.id }, orderBy: { code: 'asc' } })).map(c => c.code);
  const qCard = await quote(sareeLine, { couponCodes: [firstCard], customerId: C.walkin });
  const draftOrder = await order(qCard, sareeLine, { customerId: C.walkin, couponCodes: [firstCard] });
  check('a draft order with the card spends it', !!(await prisma.offerCode.findFirst({ where: { code: firstCard, usedAt: { not: null } } })));
  await salesOrderService.deleteOrder(CLIENT, draftOrder.id);
  const freed = await prisma.offerCode.findFirstOrThrow({ where: { clientId: CLIENT, code: firstCard } });
  check('deleting the draft makes the card good again', freed.usedAt == null && freed.salesOrderId == null, JSON.stringify(freed));
  check('  ...and gives the use back', (await prisma.offer.findUniqueOrThrow({ where: { id: cards.id } })).usageCount === 0);
  const again = await order(await quote(sareeLine, { couponCodes: [firstCard], customerId: C.walkin }), sareeLine, { customerId: C.walkin, couponCodes: [firstCard], data: { status: 'CONFIRMED' } });
  check('  ...so the customer can use it on a real order', Number(again.discountAmount) === 500, String(again.discountAmount));
  await refuses('a deleted order cannot be deleted twice', /not found/i, () => salesOrderService.deleteOrder(CLIENT, draftOrder.id));

  const both = await Promise.allSettled([salesOrderService.cancelOrder(CLIENT, again.id), salesOrderService.cancelOrder(CLIENT, again.id)]);
  const cancelled = both.filter(b => b.status === 'fulfilled').length;
  check('two cancels of one order at the same moment: one succeeds', cancelled === 1, both.map((b: any) => b.status === 'rejected' ? b.reason?.message : 'ok').join(' | '));
  check('  ...and the use is given back once, not twice', (await prisma.offer.findUniqueOrThrow({ where: { id: cards.id } })).usageCount === 0);
  check('  ...and the card is good again', (await prisma.offerCode.findFirstOrThrow({ where: { clientId: CLIENT, code: firstCard } })).usedAt == null);
  check('  ...with exactly one redemption released', (await prisma.offerRedemption.count({ where: { offerId: cards.id, salesOrderId: again.id, status: 'RELEASED' } })) === 1);
  await pauseAll();

  // ── F. CUSTOMERS AND CODES ─────────────────────────────────────────────
  console.log('\nF. CUSTOMERS AND CODES');
  const created: any = await customerService.createCustomer(CLIENT, { name: 'Radha', phone: `9${String(STAMP).slice(-9)}`, tags: [' vip ', 'VIP', 'Staff'] });
  check('a customer created in groups is saved in them, tidied', JSON.stringify(created.tags) === JSON.stringify(['vip', 'Staff']), JSON.stringify(created.tags));
  const overHttp = await owner.post('/customers', { name: 'Lalitha', phone: `8${String(STAMP).slice(-9)}`, tags: ['Wholesale'] });
  check('  ...over HTTP too', (un(overHttp)?.tags ?? []).includes('Wholesale'), `${overHttp.status} ${JSON.stringify(overHttp.data).slice(0, 160)}`);

  const listCashier = await cashier.get(`/offers/${cards.id}/codes`, { params: { all: 1 } });
  check('a cashier cannot copy out the single-use codes', listCashier.status === 403, String(listCashier.status));
  const listOwner = await owner.get(`/offers/${cards.id}/codes`, { params: { all: 1 } });
  check('  ...someone who can change offers can', listOwner.status === 200 && un(listOwner)?.codes?.length === 5, String(listOwner.status));
}

main()
  .catch(e => { failed++; failures.push(`crashed: ${e?.message ?? e}`); console.error(e); })
  .finally(async () => {
    const c = CLIENT;
    await prisma.inventoryAlert.deleteMany({ where: { clientId: c } }).catch(() => {});
    await prisma.salesLedger.deleteMany({ where: { clientId: c } }).catch(() => {});
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
