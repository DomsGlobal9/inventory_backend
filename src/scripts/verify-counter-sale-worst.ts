/**
 * Selling at the counter, when things go wrong at the same moment, or oddly, or on purpose.
 *
 *   A  two tills and one last piece; one new customer rung up at two tills at once; one card code
 *      used at two tills at once
 *   B  a price worked out for one customer used for another -- including a new customer made at the sale
 *   C  money: a free bill, paise that must add up, discounts by hand stacked past the limit
 *   D  what people type: nonsense quantities and amounts, Telugu and HTML in names, % in a search
 *   E  the catalogue changing under an open basket: retired product, bin, closed store, stopped here
 *   F  people: a disabled login, a permission taken away, another shop's staff and data
 *   G  a brand-new shop with no settings at all
 *   H  after the sale: returning a piece, and no way to cancel, delete or re-price it
 *   I  a draft order cannot be given money off by a salesperson through the edit route either
 *
 * Throwaway shops, deleted at the end. Needs the API on :4006.
 *
 *   npx tsx src/scripts/verify-counter-sale-worst.ts
 */
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { offerService } from '../services/offers';
import { forgetShopSettings } from '../lib/clientSettings';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `counter-worst-${STAMP}`;
const OTHER = `counter-worst-other-${STAMP}`;
const FRESH = `counter-worst-fresh-${STAMP}`;

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 260)}`;
const noLeak = (r: any) => !/prisma|Invalid `|constraint|P20\d\d|stack|at Object\./i.test(JSON.stringify(r.data));
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const sent: number[] = [];
async function pace() {
  const now = Date.now();
  while (sent.length && now - sent[0] > 60_000) sent.shift();
  if (sent.length >= 88) {
    const w = 60_000 - (now - sent[0]) + 500;
    console.log(`  (pausing ${Math.ceil(w / 1000)}s for the rate limit)`);
    await wait(w);
    sent.length = 0;
  }
  sent.push(Date.now());
}
const client = (token: string): AxiosInstance => {
  const api = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true, timeout: 90_000 });
  api.interceptors.request.use(async cfg => { await pace(); return cfg; });
  return api;
};
async function person(clientId: string, name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId, email: `worst-${name.replace(/\W/g, '')}-${clientId}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, api: client(AuthService.generateToken({ userId: u.id, clientId })) };
}
const tail = String(STAMP).slice(-6);
const phone = (n: number) => `9${n}${tail}${(n * 7) % 10}${(n * 3) % 10}`.slice(0, 10);

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Worst Case Silks', manualDiscountMaxPercent: 10 } });
  const owner = await person(SHOP, 'Owner Ravi', roles.ADMIN);
  const tillA = await person(SHOP, 'Till A', roles.SALES);
  const tillB = await person(SHOP, 'Till B', roles.SALES);
  const quitter = await person(SHOP, 'Leaving Soon', roles.SALES);
  const demoted = await person(SHOP, 'Moved To Stock', roles.SALES);

  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE', active: true } });
  const branch = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Branch', code: 'BRANCH', type: 'STORE', active: true } });
  const mk = async (title: string, price: number, qty: number, extra: any = {}) => {
    const p = await prisma.product.create({ data: { clientId: SHOP, title, productCode: `W-${title.replace(/\W/g, '')}-${STAMP}`, slug: `w-${title.replace(/\W/g, '').toLowerCase()}-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', dressType: extra.dressType ?? 'Saree', basePrice: price, status: 'ACTIVE' } });
    const v = await prisma.productVariant.create({ data: { clientId: SHOP, productId: p.id, sku: `W-${title.replace(/\W/g, '').toUpperCase()}-${STAMP}`, variantCode: `WV-${title.replace(/\W/g, '')}-${STAMP}`, colorName: 'Red', size: 'Free', sellingPrice: price, costPrice: price / 2, averageCost: price / 2 } });
    await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: v.id, locationId: store.id, quantity: qty } });
    await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: v.id, locationId: branch.id, quantity: qty } });
    return { v, p };
  };
  const last = await mk('Last Piece Saree', 5000, 1);
  const plenty = await mk('Everyday Saree', 1000, 100);
  const paiseItem = await mk('Dupatta Paise', 450.5, 20, { dressType: 'Dupatta' });
  const retired = await mk('Retiring Saree', 2000, 5);
  const binned = await mk('Binned Saree', 2000, 5);
  const stopped = await mk('Stopped Here Saree', 2000, 5);

  const vip = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `W-VIP-${STAMP}`, name: 'Vani VIP', phone: `+91${phone(1)}`, status: 'ACTIVE', tags: ['VIP'] } });
  const walkin = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `W-WALK-${STAMP}`, name: 'Walk In', phone: `+91${phone(2)}`, status: 'ACTIVE' } });

  const quote = async (api: AxiosInstance, lines: any[], extra: any = {}, locationId = store.id) => {
    const r = await api.post('/pricing/quote', { locationId, channel: 'POS', lines, ...extra });
    if (r.status !== 200) throw new Error(`quote ${brief(r)}`);
    return r.data.data;
  };
  const sale = (api: AxiosInstance, body: any) => api.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: store.id, ...body });
  const stock = async (variantId: string, locationId = store.id) => {
    const s = await prisma.inventoryStock.findFirstOrThrow({ where: { variantId, locationId } });
    return { onHand: s.quantity, held: s.reservedQty };
  };
  const counts = async (clientId = SHOP) => ({
    orders: await prisma.salesOrder.count({ where: { clientId } }),
    customers: await prisma.customer.count({ where: { clientId } }),
    payments: await prisma.salesOrderPayment.count({ where: { clientId } }),
    movements: await prisma.inventoryTransaction.count({ where: { clientId } })
  });
  const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
  const one = (v: any, quantity = 1) => [{ variantId: v.id, quantity }];

  // ── A ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nA. TWO TILLS AT THE SAME MOMENT');
  const [qa, qb] = await Promise.all([quote(tillA.api, one(last.v)), quote(tillB.api, one(last.v))]);
  const race = await Promise.all([
    sale(tillA.api, { quoteId: qa.quoteId, customer: { id: vip.id }, items: one(last.v), payments: [{ method: 'CASH', amount: 5000 }] }),
    sale(tillB.api, { quoteId: qb.quoteId, customer: { id: walkin.id }, items: one(last.v), payments: [{ method: 'UPI', amount: 5000 }] })
  ]);
  const statuses = race.map(r => r.status).sort().join(',');
  const loser = race.find(r => r.status !== 201);
  check('two tills selling the last piece: exactly one sale', statuses === '201,409', race.map(brief).join(' | '));
  check('  ...the other is told it is gone, by name, and nothing of theirs is kept', loser?.data?.details?.code === 'OUT_OF_STOCK' && /Last Piece Saree/.test(loser?.data?.message) && noLeak(loser), brief(loser));
  check('  ...the shelf is 0, nothing held, never below zero', same(await stock(last.v.id), { onHand: 0, held: 0 }), JSON.stringify(await stock(last.v.id)));
  check('  ...one payment row, not two', (await prisma.salesOrderPayment.count({ where: { clientId: SHOP } })) === 1);

  const newNumber = phone(3);
  const [qc, qd] = await Promise.all([quote(tillA.api, one(plenty.v)), quote(tillB.api, one(plenty.v, 2))]);
  const beforeTwin = await counts();
  const twin = await Promise.all([
    sale(tillA.api, { quoteId: qc.quoteId, customer: { phone: newNumber, name: 'Kavya New' }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 1000 }] }),
    sale(tillB.api, { quoteId: qd.quoteId, customer: { phone: `+91 ${newNumber}`, name: 'Kavya N' }, items: one(plenty.v, 2), payments: [{ method: 'CASH', amount: 2000 }] })
  ]);
  const twinAfter = await counts();
  check('one new customer rung up at two tills at once: both sales go through', twin.every(r => r.status === 201), twin.map(brief).join(' | '));
  check('  ...as ONE customer, with both sales on her', twinAfter.customers === beforeTwin.customers + 1 && twin[0].data?.data?.customer?.id === twin[1].data?.data?.customer?.id, `${JSON.stringify(beforeTwin)} -> ${JSON.stringify(twinAfter)}`);

  const card = await offerService.create(SHOP, { name: 'Card 300', trigger: 'CODE', uniqueCodes: true, level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 300, scope: 'ALL', startsAt: new Date(Date.now() - 86400000), endsAt: null }, 'owner') as any;
  await offerService.makeCodes(SHOP, card.id, 'CARD', 3);
  await offerService.setStatus(SHOP, card.id, 'ACTIVE', 'owner');
  const code = (await prisma.offerCode.findFirstOrThrow({ where: { offerId: card.id }, orderBy: { code: 'asc' } })).code;
  const [qe, qf] = await Promise.all([quote(tillA.api, one(plenty.v, 2), { couponCodes: [code] }), quote(tillB.api, one(plenty.v, 2), { couponCodes: [code] })]);
  check('a card code prices the basket at both tills (1,700)', qe.total === 1700 && qf.total === 1700, `${qe.total} ${qf.total}`);
  const beforeCode = await counts();
  const codeRace = await Promise.all([
    sale(tillA.api, { quoteId: qe.quoteId, couponCodes: [code], customer: { id: vip.id }, items: one(plenty.v, 2), payments: [{ method: 'CASH', amount: 1700 }] }),
    sale(tillB.api, { quoteId: qf.quoteId, couponCodes: [code], customer: { id: walkin.id }, items: one(plenty.v, 2), payments: [{ method: 'CASH', amount: 1700 }] })
  ]);
  const codeAfter = await counts();
  check('one card code used at two tills at once: one sale gets it', codeRace.filter(r => r.status === 201).length === 1, codeRace.map(brief).join(' | '));
  check('  ...the other is refused cleanly and saves nothing', codeAfter.orders === beforeCode.orders + 1 && codeAfter.payments === beforeCode.payments + 1 && codeRace.every(noLeak), `${JSON.stringify(beforeCode)} -> ${JSON.stringify(codeAfter)}`);
  check('  ...the code is marked used once', (await prisma.offerCode.count({ where: { offerId: card.id, code, usedAt: { not: null } } })) === 1);

  // ── B ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. A PRICE FOR ONE CUSTOMER, USED FOR ANOTHER');
  const vipOffer = await offerService.create(SHOP, { name: 'VIP 30%', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE', value: 30, scope: 'ALL', customerTags: ['VIP'], startsAt: new Date(Date.now() - 86400000), endsAt: null }, 'owner') as any;
  await offerService.setStatus(SHOP, vipOffer.id, 'ACTIVE', 'owner');
  const qVip = await quote(tillA.api, one(plenty.v), { customerId: vip.id });
  check('the VIP is quoted 700', qVip.total === 700, String(qVip.total));
  const b1 = await sale(tillA.api, { quoteId: qVip.quoteId, customer: { id: walkin.id }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 700 }] });
  check('the VIP price used for a walk-in is refused (409, re-price)', b1.status === 409 && b1.data.details?.code === 'PRICE_CHANGED', brief(b1));
  const beforeB2 = await counts();
  const b2 = await sale(tillA.api, { quoteId: qVip.quoteId, customer: { phone: phone(4), name: 'Brand New' }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 700 }] });
  check('the VIP price used for a brand-new customer is refused, and that customer is not saved', b2.status === 409 && same(beforeB2, await counts()), brief(b2));
  const b3 = await sale(tillA.api, { quoteId: qVip.quoteId, customer: { id: vip.id }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 700 }] });
  check('the VIP pays 700 as quoted', b3.status === 201 && b3.data.data.total === 700, brief(b3));
  await offerService.setStatus(SHOP, vipOffer.id, 'PAUSED', 'owner');

  // ── C ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. MONEY');
  const qFree = await quote(owner.api, one(plenty.v));
  const freeWithPay = await sale(owner.api, { quoteId: qFree.quoteId, customer: { id: walkin.id }, items: [{ variantId: plenty.v.id, quantity: 1, manualDiscount: { amount: 1000, reason: 'Replacement for a torn saree' } }], payments: [{ method: 'CASH', amount: 1 }] });
  check('a bill taken to 0 refuses a payment (400)', freeWithPay.status === 400 && /nothing to pay/i.test(freeWithPay.data.message), brief(freeWithPay));
  const free = await sale(owner.api, { quoteId: qFree.quoteId, customer: { id: walkin.id }, items: [{ variantId: plenty.v.id, quantity: 1, manualDiscount: { amount: 1000, reason: 'Replacement for a torn saree' } }], payments: [] });
  check('a manager can give one away with a reason: total 0, counted as paid, stock still off', free.status === 201 && free.data.data.total === 0 && free.data.data.payment.status === 'PAID' && free.data.data.status === 'DISPATCHED', brief(free));
  const qFreeSales = await quote(tillA.api, one(plenty.v));
  const freeBySales = await sale(tillA.api, { quoteId: qFreeSales.quoteId, customer: { id: walkin.id }, items: [{ variantId: plenty.v.id, quantity: 1, manualDiscount: { amount: 1000, reason: 'Replacement for a torn saree' } }], payments: [] });
  check('a salesperson cannot give one away (403)', freeBySales.status === 403, brief(freeBySales));

  const tenOff = await offerService.create(SHOP, { name: 'Dupatta 10%', trigger: 'AUTOMATIC', level: 'LINE', valueType: 'PERCENTAGE', value: 10, scope: 'DRESS_TYPE', targets: [{ scope: 'DRESS_TYPE', refId: 'Dupatta' }], startsAt: new Date(Date.now() - 86400000), endsAt: null }, 'owner') as any;
  await offerService.setStatus(SHOP, tenOff.id, 'ACTIVE', 'owner');
  const qPaise = await quote(tillA.api, one(paiseItem.v, 3));
  const expected = Math.round(45050 * 3 * 0.9) / 100;
  check(`3 × 450.50 less 10% prices to the paisa (${expected})`, qPaise.total === expected, String(qPaise.total));
  const payPaise = await sale(tillA.api, { quoteId: qPaise.quoteId, customer: { id: walkin.id }, items: one(paiseItem.v, 3), payments: [{ method: 'UPI', amount: 1000 }, { method: 'CASH', amount: Math.round((expected - 1000) * 100) / 100, cashReceived: 300 }] });
  const ledger = payPaise.data?.data ? await prisma.salesLedger.findFirst({ where: { salesOrderId: payPaise.data.data.id } }) : null;
  check('  ...a split in paise adds up, change 83.35 worked out, revenue is the bill exactly', payPaise.status === 201 && payPaise.data.data.total === expected && Number(ledger?.revenue) === expected && payPaise.data.data.payments.find((p: any) => p.method === 'CASH')?.changeGiven === Math.round((300 - (expected - 1000)) * 100) / 100, brief(payPaise));
  const offByPaisa = await sale(tillA.api, { quoteId: (await quote(tillA.api, one(paiseItem.v, 3))).quoteId, customer: { id: walkin.id }, items: one(paiseItem.v, 3), payments: [{ method: 'UPI', amount: expected - 0.01 }] });
  check('  ...one paisa short is refused', offByPaisa.status === 400 && offByPaisa.data.details?.code === 'PAYMENT_MISMATCH', brief(offByPaisa));
  await offerService.setStatus(SHOP, tenOff.id, 'PAUSED', 'owner');

  const qStack = await quote(tillA.api, one(plenty.v, 2));
  const stacked = await sale(tillA.api, { quoteId: qStack.quoteId, customer: { id: walkin.id }, items: [{ variantId: plenty.v.id, quantity: 2, manualDiscount: { amount: 200, reason: 'Loyal customer discount' } }], manualDiscount: { amount: 180, reason: 'Bulk purchase discount' }, payments: [{ method: 'CASH', amount: 1620 }] });
  check('10% off the line and 10% off the bill by a salesperson is 19% -- refused (403)', stacked.status === 403, brief(stacked));

  // ── D ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. WHAT PEOPLE TYPE');
  const qD = await quote(tillA.api, one(plenty.v));
  const base = { quoteId: qD.quoteId, customer: { id: walkin.id }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 1000 }] };
  const bad: [string, any][] = [
    ['quantity 0', { items: [{ variantId: plenty.v.id, quantity: 0 }] }],
    ['quantity 1.5', { items: [{ variantId: plenty.v.id, quantity: 1.5 }] }],
    ['quantity 10,001', { items: [{ variantId: plenty.v.id, quantity: 10001 }] }],
    ['quantity as text', { items: [{ variantId: plenty.v.id, quantity: '1' }] }],
    ['a sale id that is not an id', { saleId: 'abc' }],
    ['seven ways to split', { payments: Array.from({ length: 7 }, () => ({ method: 'CASH', amount: 1 })) }],
    ['an amount of 0.001', { payments: [{ method: 'CASH', amount: 0.001 }] }],
    ['a negative amount', { payments: [{ method: 'CASH', amount: -1000 }] }],
    ['cash received of 2 crore', { payments: [{ method: 'CASH', amount: 1000, cashReceived: 20000000 }] }],
    ['a method that does not exist', { payments: [{ method: 'CHEQUE', amount: 1000 }] }],
    ['the same item twice', { items: [...one(plenty.v), ...one(plenty.v)] }],
    ['no items', { items: [] }],
    ['a customer with neither id nor phone', { customer: { name: 'Nobody' } }],
    ['a total sent by the screen', { total: 1 }],
    ['an empty body', null]
  ];
  for (const [label, over] of bad) {
    const before = await counts();
    const r = over === null ? await tillA.api.post('/counter-sales', {}) : await sale(tillA.api, { ...base, ...over });
    check(`refused: ${label} (400), nothing saved, no internals shown`, r.status === 400 && noLeak(r) && same(before, await counts()) && typeof r.data?.message === 'string', brief(r));
  }
  const teluguName = 'లక్ష్మి దేవి <b>&amp;</b>';
  const qT = await quote(tillA.api, one(plenty.v));
  const telugu = await sale(tillA.api, { quoteId: qT.quoteId, customer: { phone: phone(5), name: teluguName }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 1000 }] });
  check('a Telugu name with HTML in it is saved exactly as typed', telugu.status === 201 && telugu.data.data.customer.name === teluguName, brief(telugu));
  const percent = await owner.api.get('/sales-orders', { params: { search: '%' } });
  const underscore = await owner.api.get('/sales-orders', { params: { search: '_' } });
  check('searching orders for % or _ is not a wildcard for everything', percent.status === 200 && underscore.status === 200 && percent.data.length === 0 && underscore.data.length === 0, `${percent.data?.length} ${underscore.data?.length}`);
  const byTelugu = await owner.api.get('/sales-orders', { params: { search: 'లక్ష్మి' } });
  check('orders can be found by a Telugu name', byTelugu.status === 200 && byTelugu.data.length === 1, String(byTelugu.data?.length));
  const itemsPercent = await tillA.api.get('/counter-sales/items', { params: { q: '%', locationId: store.id } });
  check('item search for % finds nothing rather than everything', itemsPercent.status === 200 && itemsPercent.data.data.items.length === 0, brief(itemsPercent));

  // ── E ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nE. THE CATALOGUE CHANGING UNDER AN OPEN BASKET');
  const qR = await quote(tillA.api, one(retired.v));
  await prisma.product.update({ where: { id: retired.p.id }, data: { status: 'ARCHIVED' } });
  const beforeR = await counts();
  const rRetired = await sale(tillA.api, { quoteId: qR.quoteId, customer: { id: walkin.id }, items: one(retired.v), payments: [{ method: 'CASH', amount: 2000 }] });
  check('a product retired after it went in the basket is refused (409), nothing saved', rRetired.status === 409 && /no longer sold|retired/i.test(rRetired.data.message) && same(beforeR, await counts()), brief(rRetired));
  const qBin = await quote(tillA.api, one(binned.v));
  await prisma.product.update({ where: { id: binned.p.id }, data: { trashedAt: new Date(), status: 'TRASHED' } });
  const rBin = await sale(tillA.api, { quoteId: qBin.quoteId, customer: { id: walkin.id }, items: one(binned.v), payments: [{ method: 'CASH', amount: 2000 }] });
  check('a product moved to the bin after it went in the basket is refused (409)', rBin.status === 409, brief(rBin));
  const searchRetired = await tillA.api.get('/counter-sales/items', { params: { q: 'Retiring', locationId: store.id } });
  check('...and neither shows in the item search', searchRetired.data?.data?.items?.length === 0, brief(searchRetired));
  await prisma.variantLocationProfile.create({ data: { variantId: stopped.v.id, locationId: store.id, isAvailable: false } });
  const searchStopped = await tillA.api.get('/counter-sales/items', { params: { q: 'Stopped Here', locationId: store.id } });
  check('an item stopped at this store shows as not sellable here', searchStopped.data?.data?.items?.[0]?.sellableHere === false, brief(searchStopped));
  const quoteStopped = await tillA.api.post('/pricing/quote', { locationId: store.id, channel: 'POS', lines: one(stopped.v) });
  check('...and cannot be priced here (400)', quoteStopped.status === 400, brief(quoteStopped));
  const qClose = await quote(tillA.api, one(plenty.v), {}, branch.id);
  await prisma.stockLocation.update({ where: { id: branch.id }, data: { active: false } });
  const rClosed = await tillA.api.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: branch.id, quoteId: qClose.quoteId, customer: { id: walkin.id }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 1000 }] });
  check('a store switched off after the basket was priced cannot sell (400)', rClosed.status === 400 && /closed/i.test(rClosed.data.message), brief(rClosed));
  const qPriceUp = await quote(tillA.api, one(plenty.v));
  await prisma.productVariant.update({ where: { id: plenty.v.id }, data: { sellingPrice: 1200 } });
  const rPriceUp = await sale(tillA.api, { quoteId: qPriceUp.quoteId, customer: { id: walkin.id }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 1000 }] });
  check('a price raised after the basket was priced: the customer pays what they were shown (1,000)', rPriceUp.status === 201 && rPriceUp.data.data.total === 1000, brief(rPriceUp));
  await prisma.productVariant.update({ where: { id: plenty.v.id }, data: { sellingPrice: 1000 } });

  // ── F ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nF. PEOPLE');
  await prisma.user.update({ where: { id: quitter.id }, data: { status: 'INACTIVE' } });
  let quitterStatus = 0;
  for (let i = 0; i < 14; i++) {
    const r = await quitter.api.get('/counter-sales/items', { params: { q: 'saree', locationId: store.id } });
    quitterStatus = r.status;
    if (r.status === 401) break;
    await wait(5000);
  }
  check('a login switched off is refused (401)', quitterStatus === 401, String(quitterStatus));
  await prisma.userRole.deleteMany({ where: { userId: demoted.id } });
  await prisma.userRole.create({ data: { userId: demoted.id, roleId: roles.WAREHOUSE } });
  let demotedStatus = 0;
  for (let i = 0; i < 14; i++) {
    const r = await demoted.api.get('/counter-sales/items', { params: { q: 'saree', locationId: store.id } });
    demotedStatus = r.status;
    if (r.status === 403) break;
    await wait(5000);
  }
  check('someone moved to the stock room loses the counter (403)', demotedStatus === 403, String(demotedStatus));

  const otherRoles = await seedRolesForClient(OTHER);
  const outsider = await person(OTHER, 'Other Shop Owner', otherRoles.ADMIN);
  const someSale = b3.data.data.id;
  const peek = await outsider.api.get(`/counter-sales/${someSale}/receipt`);
  check('another shop cannot read this shop\'s receipt (404)', peek.status === 404 && !JSON.stringify(peek.data).includes('Vani'), brief(peek));
  const peekItems = await outsider.api.get('/counter-sales/items', { params: { q: 'saree', locationId: store.id } });
  check('...or search this shop\'s store (404)', peekItems.status === 404, brief(peekItems));
  const peekPhone = await outsider.api.get(`/customers/by-phone/${encodeURIComponent('+91' + phone(1))}`);
  check('...or find this shop\'s customer by phone', peekPhone.status === 200 && peekPhone.data.data === null, brief(peekPhone));
  const peekOrders = await outsider.api.get('/sales-orders', { params: { search: 'Vani' } });
  check('...or see its orders in a search', peekOrders.status === 200 && peekOrders.data.length === 0, brief(peekOrders));
  const outsiderSells = await outsider.api.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: store.id, quoteId: qD.quoteId, customer: { id: walkin.id }, items: one(plenty.v), payments: [{ method: 'CASH', amount: 1000 }] });
  check('...or sell from its store with its quote (refused, nothing saved)', [400, 404, 409].includes(outsiderSells.status) && (await prisma.salesOrder.count({ where: { clientId: OTHER } })) === 0, brief(outsiderSells));

  // ── G ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nG. A BRAND-NEW SHOP');
  const freshRoles = await seedRolesForClient(FRESH);
  const freshOwner = await person(FRESH, 'First Owner', freshRoles.SUPER_ADMIN);
  const freshSales = await person(FRESH, 'First Sales', freshRoles.SALES);
  const freshStore = await prisma.stockLocation.create({ data: { clientId: FRESH, name: 'Only Store', code: 'MAIN-STORE', type: 'STORE', active: true } });
  const fp = await prisma.product.create({ data: { clientId: FRESH, title: 'First Saree', productCode: `F-${STAMP}`, slug: `f-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 999, status: 'DRAFT' } });
  const fv = await prisma.productVariant.create({ data: { clientId: FRESH, productId: fp.id, sku: `F-${STAMP}`, variantCode: `FV-${STAMP}` } });
  await prisma.inventoryStock.create({ data: { clientId: FRESH, variantId: fv.id, locationId: freshStore.id, quantity: 2 } });
  const freshSearch = await freshOwner.api.get('/counter-sales/items', { params: { q: 'first', locationId: freshStore.id } });
  check('a shop with no settings, a draft product and no variant price: the item is found at the product price', freshSearch.status === 200 && freshSearch.data.data.items[0]?.price === 999, brief(freshSearch));
  const fq = (await freshOwner.api.post('/pricing/quote', { locationId: freshStore.id, channel: 'POS', lines: [{ variantId: fv.id, quantity: 1 }] })).data.data;
  const freshSale = await freshOwner.api.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: freshStore.id, quoteId: fq.quoteId, customer: { phone: phone(1), name: 'First Ever Customer' }, items: [{ variantId: fv.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 999, cashReceived: 1000 }] });
  check('the owner\'s first ever sale goes through, numbered SO-000001 and CUS-000001', freshSale.status === 201 && freshSale.data.data.orderNumber === 'SO-000001' && freshSale.data.data.customer.code === 'CUS-000001', brief(freshSale));
  check('...the receipt falls back to the store name when the shop has no name yet', freshSale.data?.data?.shop?.name === null && freshSale.data?.data?.store?.name === 'Only Store', JSON.stringify(freshSale.data?.data?.shop));
  check('...the same phone number as a customer of ANOTHER shop is a new customer here', freshSale.data?.data?.customer?.id !== vip.id);
  forgetShopSettings(FRESH);
  const fq2 = (await freshSales.api.post('/pricing/quote', { locationId: freshStore.id, channel: 'POS', lines: [{ variantId: fv.id, quantity: 1 }] })).data.data;
  const noLimit = await freshSales.api.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: freshStore.id, quoteId: fq2.quoteId, customer: { phone: phone(1) }, items: [{ variantId: fv.id, quantity: 1, manualDiscount: { amount: 499.5, reason: 'Opening day offer' } }], payments: [{ method: 'CASH', amount: 499.5 }] });
  check('a shop that never set a till limit: its salesperson may take 50% off (limit is the shop\'s to set)', noLimit.status === 201 && noLimit.data.data.total === 499.5, brief(noLimit));

  // ── H ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nH. AFTER THE SALE');
  const sold = b3.data.data;
  const dispatchItem = await prisma.dispatchItem.findFirstOrThrow({ where: { salesOrderItem: { salesOrderId: sold.id } } });
  const beforeReturn = await stock(plenty.v.id);
  const ret = await owner.api.post('/returns', { salesOrderId: sold.id, items: [{ dispatchItemId: dispatchItem.id, quantity: 1 }], reason: 'CUSTOMER_REJECTED', notes: 'Colour not as expected' });
  const retId = ret.data?.data?.id;
  const retItems = ret.data?.data?.items ?? [];
  const r1 = await owner.api.post(`/returns/${retId}/receive`);
  const r2 = await owner.api.post(`/returns/${retId}/inspect`, { itemsDisposition: retItems.map((i: any) => ({ salesReturnItemId: i.id, disposition: 'RESTOCK' })) });
  const r3 = await owner.api.post(`/returns/${retId}/complete`);
  check('a counter sale can be returned: logged, received, inspected, completed', [ret.status, r1.status, r2.status, r3.status].join() === '201,200,200,200', [ret, r1, r2, r3].map(brief).join(' | '));
  check('  ...the piece is back on the shelf', (await stock(plenty.v.id)).onHand === beforeReturn.onHand + 1, `${JSON.stringify(beforeReturn)} -> ${JSON.stringify(await stock(plenty.v.id))}`);
  const again = await owner.api.post('/returns', { salesOrderId: sold.id, items: [{ dispatchItemId: dispatchItem.id, quantity: 1 }], reason: 'CUSTOMER_REJECTED', notes: 'Trying twice' });
  check('  ...and the same piece cannot be returned twice', again.status >= 400 && noLeak(again), brief(again));
  const cancel = await owner.api.post(`/sales-orders/${sold.id}/cancel`);
  const del = await owner.api.delete(`/sales-orders/${sold.id}`);
  const patch = await owner.api.patch(`/sales-orders/${sold.id}`, { discountAmount: 500 });
  const addLine = await owner.api.post(`/sales-orders/${sold.id}/items`, { variantId: plenty.v.id, quantity: 1 });
  const soldAfter = await prisma.salesOrder.findFirstOrThrow({ where: { id: sold.id } });
  check('a counter sale cannot be cancelled, deleted, re-priced or added to', [cancel, del, patch, addLine].every(r => r.status >= 400 && r.status < 500) && Number(soldAfter.total) === 700 && soldAfter.deletedAt === null, [cancel, del, patch, addLine].map(brief).join(' | '));

  // ── I ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nI. A DRAFT ORDER THROUGH THE EDIT ROUTE');
  const draft = await tillA.api.post('/sales-orders/full', { locationId: store.id, customer: { id: walkin.id }, items: one(plenty.v, 2) });
  const draftOff = await tillA.api.patch(`/sales-orders/${draft.data?.id}`, { discountAmount: 1500 });
  const draftAfter = await prisma.salesOrder.findFirst({ where: { id: draft.data?.id } });
  check('a salesperson cannot take money off a draft by editing it (403), total unchanged', draft.status === 201 && draftOff.status === 403 && Number(draftAfter?.total) === 2000, `${brief(draftOff)} total=${draftAfter?.total}`);
  const draftShipping = await tillA.api.patch(`/sales-orders/${draft.data?.id}`, { shippingAmount: 100 });
  check('...but can still add shipping', draftShipping.status === 200, brief(draftShipping));
  const managerOff = await owner.api.patch(`/sales-orders/${draft.data?.id}`, { discountAmount: 100 });
  check('...and a manager can still take money off a draft', managerOff.status === 200, brief(managerOff));
}

async function cleanup() {
  for (const id of [SHOP, OTHER, FRESH]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => {
      if (!/No such client/.test(e?.message)) check(`shop ${id} deleted`, false, e?.message);
    });
  }
  const left = await prisma.salesOrder.count({ where: { clientId: { in: [SHOP, OTHER, FRESH] } } })
    + await prisma.customer.count({ where: { clientId: { in: [SHOP, OTHER, FRESH] } } })
    + await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER, FRESH] } } });
  check('all three throwaway shops are gone', left === 0, String(left));
}

main()
  .catch(e => { failed++; failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => console.error('cleanup failed', e));
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
