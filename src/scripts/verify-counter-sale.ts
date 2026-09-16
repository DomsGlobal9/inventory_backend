/**
 * Selling at the counter, end to end, through the API a till uses.
 *
 *   A  finding an item: a scanned barcode is one item; words narrow; the price and stock are THIS
 *      store's; a closed or foreign store is refused; no cost anywhere; a stock-room role cannot
 *   B  Complete sale: customer made from the phone, stock off once, one dispatch, revenue, payments
 *      with change, DISPATCHED + TAKEN_NOW + POS, who sold it, the receipt, the audit id
 *   C  the same sale again: a repeat press, a different basket on the same id, two presses at once
 *   D  refusals leave nothing behind -- no order, no customer, no stock moved, no order number used
 *   E  money off by hand: within the limit, over it, no reason, no permission, a manager
 *   F  the older order route holds a salesperson to the catalogue price
 *   G  cancelling: before anything went out, after part went out (closed short), twice at once
 *   H  a dispatch that names the same line twice, or nothing, or a cancelled order
 *   I  deleting the shop takes its payments with it
 *
 * A throwaway shop of its own, deleted at the end through the Platform Console's own delete.
 * Needs the API on :4006.
 *
 *   npx tsx src/scripts/verify-counter-sale.ts
 */
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { salesOrderService } from '../services/sales-order.service';
import { dispatchService } from '../services/dispatch.service';
import { platformAdminService } from '../services/platform-admin.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const CLIENT = `counter-sale-${STAMP}`;
const OTHER = `counter-other-${STAMP}`;

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`;
const noCost = (r: any) => !/costPrice|averageCost|unitCost|totalCost|grossProfit|lastPurchaseCost|inventoryValue/.test(JSON.stringify(r.data));
const noLeak = (r: any) => !/prisma|Invalid `|constraint|P20\d\d/i.test(JSON.stringify(r.data));

// The API allows 100 requests a minute from one address. Paced rather than tripped.
const sent: number[] = [];
async function pace() {
  const now = Date.now();
  while (sent.length && now - sent[0] > 60_000) sent.shift();
  if (sent.length >= 90) {
    const wait = 60_000 - (now - sent[0]) + 500;
    console.log(`  (pausing ${Math.ceil(wait / 1000)}s for the rate limit)`);
    await new Promise(r => setTimeout(r, wait));
    sent.length = 0;
  }
  sent.push(Date.now());
}
function client(token: string): AxiosInstance {
  const api = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true, timeout: 60_000 });
  api.interceptors.request.use(async cfg => { await pace(); return cfg; });
  return api;
}

const tail = String(STAMP).slice(-6);
const phone = (n: number) => `8${n}${tail}${n}${n}`.slice(0, 10);

async function person(name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId: CLIENT, email: `counter-${name}-${STAMP}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, api: client(AuthService.generateToken({ userId: u.id, clientId: CLIENT })) };
}

const stockOf = async (variantId: string, locationId: string) => {
  const s = await prisma.inventoryStock.findFirst({ where: { variantId, locationId } });
  return { onHand: s?.quantity ?? 0, reserved: s?.reservedQty ?? 0 };
};
const counts = async () => ({
  orders: await prisma.salesOrder.count({ where: { clientId: CLIENT } }),
  customers: await prisma.customer.count({ where: { clientId: CLIENT } }),
  payments: await prisma.salesOrderPayment.count({ where: { clientId: CLIENT } }),
  movements: await prisma.inventoryTransaction.count({ where: { clientId: CLIENT } }),
  dispatches: await prisma.dispatch.count({ where: { clientId: CLIENT } }),
  reservations: await prisma.inventoryReservation.count({ where: { clientId: CLIENT } })
});
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // ── SETUP ────────────────────────────────────────────────────────────────────────────────
  console.log(`SETUP: shop ${CLIENT}`);
  const roles = await seedRolesForClient(CLIENT);
  await prisma.clientSettings.create({ data: { clientId: CLIENT, businessName: 'Counter Test Sarees', manualDiscountMaxPercent: 10, businessAddress: '1 Letterhead Road', businessPhone: '+91 90000 00000', receiptFooter: 'Exchange within 7 days.' } });

  const counterOnly = await prisma.role.create({ data: { clientId: CLIENT, name: 'COUNTER-ONLY' } });
  const perm = await prisma.permission.findUniqueOrThrow({ where: { key: 'sales_order:counter_sale' } });
  await prisma.rolePermission.create({ data: { roleId: counterOnly.id, permissionId: perm.id } });

  const owner = await person('Ravi Owner', roles.ADMIN);
  const sales = await person('Rahul Sales', roles.SALES);
  const stockRoom = await person('Sita Stockroom', roles.WAREHOUSE);
  const cashierNoDiscount = await person('Kiran Counter', counterOnly.id);

  const storeA = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE', active: true, address: '12 MG Road, Vijayawada', phone: '+91 98480 11111' } });
  const storeB = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Branch', code: 'BRANCH', type: 'STORE', active: true } });
  const closed = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Old Branch', code: 'OLD', type: 'STORE', active: false } });
  const foreignStore = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Elsewhere', code: 'ELSE', type: 'STORE', active: true } });

  const product = await prisma.product.create({ data: { clientId: CLIENT, title: 'Silk Saree', productCode: `CS-${STAMP}`, slug: `silk-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } });
  const blouseP = await prisma.product.create({ data: { clientId: CLIENT, title: 'Cotton Blouse', productCode: `CB-${STAMP}`, slug: `blouse-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 2500, status: 'ACTIVE' } });
  const saree = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: product.id, sku: `CS-RED-${STAMP}`, variantCode: `V-CS-${STAMP}`, colorName: 'Red', size: 'Free', sellingPrice: 1000, costPrice: 600, averageCost: 600, barcode: `89${STAMP}` } });
  const sareeBlue = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: product.id, sku: `CS-BLUE-${STAMP}`, variantCode: `V-CSB-${STAMP}`, colorName: 'Blue', size: 'Free', sellingPrice: 1000, costPrice: 600, averageCost: 600 } });
  const blouse = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: blouseP.id, sku: `CB-M-${STAMP}`, variantCode: `V-CB-${STAMP}`, colorName: 'Green', size: 'M', sellingPrice: 2500, costPrice: 1500, averageCost: 1500 } });
  await prisma.inventoryStock.createMany({ data: [
    { clientId: CLIENT, variantId: saree.id, locationId: storeA.id, quantity: 20 },
    { clientId: CLIENT, variantId: blouse.id, locationId: storeA.id, quantity: 3 },
    { clientId: CLIENT, variantId: sareeBlue.id, locationId: storeA.id, quantity: 0 },
    { clientId: CLIENT, variantId: saree.id, locationId: storeB.id, quantity: 2 }
  ] });
  await prisma.variantLocationProfile.create({ data: { variantId: saree.id, locationId: storeB.id, isAvailable: true, priceOverride: 900 } });

  const quote = async (api: AxiosInstance, locationId: string, lines: { variantId: string; quantity: number }[], extra: any = {}) => {
    const r = await api.post('/pricing/quote', { locationId, channel: 'POS', lines, ...extra });
    if (r.status !== 200) throw new Error(`quote failed: ${brief(r)}`);
    return r.data.data;
  };
  const sell = (api: AxiosInstance, body: any) => api.post('/counter-sales', body);

  // ── A ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nA. FINDING AN ITEM');
  const scan = await sales.api.get('/counter-sales/items', { params: { q: `89${STAMP}`, locationId: storeA.id } });
  const it = scan.data?.data?.items?.[0];
  check('a scanned barcode is exactly one item', scan.status === 200 && scan.data.data.exact === true && scan.data.data.items.length === 1, brief(scan));
  check('...with this store\'s price and how many are free here', it?.price === 1000 && it?.available === 20 && it?.onShelf === 20, JSON.stringify(it));
  check('...and nothing about what the shop paid', noCost(scan), brief(scan));
  const words = await sales.api.get('/counter-sales/items', { params: { q: 'silk red', locationId: storeA.id } });
  check('two words narrow to the item matching both', words.status === 200 && words.data.data.items.length === 1 && words.data.data.items[0].variantId === saree.id, brief(words));
  const byName = await sales.api.get('/counter-sales/items', { params: { q: 'silk', locationId: storeA.id } });
  check('a list puts what can be sold here before what is out of stock', byName.data?.data?.items?.[0]?.variantId === saree.id && byName.data.data.items.length === 2, brief(byName));
  const atB = await sales.api.get('/counter-sales/items', { params: { q: `89${STAMP}`, locationId: storeB.id } });
  check('at another store: that store\'s price (900) and stock (2)', atB.data?.data?.items?.[0]?.price === 900 && atB.data.data.items[0].available === 2, brief(atB));
  const atClosed = await sales.api.get('/counter-sales/items', { params: { q: 'silk', locationId: closed.id } });
  check('a closed store cannot sell (400)', atClosed.status === 400 && /closed/i.test(atClosed.data.message), brief(atClosed));
  const atForeign = await sales.api.get('/counter-sales/items', { params: { q: 'silk', locationId: foreignStore.id } });
  check('another shop\'s store is not found (404)', atForeign.status === 404, brief(atForeign));
  const blank = await sales.api.get('/counter-sales/items', { params: { q: '  ', locationId: storeA.id } });
  check('an empty search is an empty list', blank.status === 200 && blank.data.data.items.length === 0, brief(blank));
  const stockRoomSearch = await stockRoom.api.get('/counter-sales/items', { params: { q: 'silk', locationId: storeA.id } });
  check('the stock room role cannot use the counter (403)', stockRoomSearch.status === 403, brief(stockRoomSearch));

  // ── B ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. COMPLETE SALE');
  const beforeB = await counts();
  const q1 = await quote(sales.api, storeA.id, [{ variantId: saree.id, quantity: 2 }, { variantId: blouse.id, quantity: 1 }]);
  check('the basket is priced at 4,500', q1.total === 4500 || Number(q1.totalMinor) === 450000, JSON.stringify(q1).slice(0, 200));
  const sale1Id = crypto.randomUUID();
  const newPhone = phone(1);
  const body1 = {
    saleId: sale1Id, locationId: storeA.id, quoteId: q1.quoteId,
    customer: { phone: `0${newPhone.slice(0, 5)} ${newPhone.slice(5)}`, name: 'Priya Walkin' },
    items: [{ variantId: saree.id, quantity: 2 }, { variantId: blouse.id, quantity: 1 }],
    payments: [{ method: 'UPI', amount: 2000, reference: '412345678901' }, { method: 'CASH', amount: 2500, cashReceived: 3000 }]
  };
  const r1 = await sell(sales.api, body1);
  const s1 = r1.data?.data;
  check('the sale is made (201)', r1.status === 201 && r1.data.replayed === false, brief(r1));
  check('...sold at the counter: DISPATCHED, taken now, POS', s1?.status === 'DISPATCHED' && s1?.handover === 'TAKEN_NOW' && s1?.channel === 'POS' && s1?.atCounter === true, brief(r1));
  check('...by the person who rang it up', s1?.soldBy === 'Rahul Sales', String(s1?.soldBy));
  check('...paid in full, with 500 change on the cash', s1?.payment?.status === 'PAID' && s1?.payment?.due === 0 && s1?.payments?.find((p: any) => p.method === 'CASH')?.changeGiven === 500, JSON.stringify(s1?.payments));
  check('...the receipt shows the store\'s own address, the shop footer, and a masked phone', s1?.shop?.address === '12 MG Road, Vijayawada' && s1?.shop?.receiptFooter === 'Exchange within 7 days.' && s1?.customer?.phoneMasked === `••••${newPhone.slice(-4)}`, JSON.stringify(s1?.shop) + JSON.stringify(s1?.customer));
  check('...and nothing about cost', noCost(r1), brief(r1));
  const cust = await prisma.customer.findFirst({ where: { clientId: CLIENT, phone: `+91${newPhone}` } });
  check('a new customer is saved with the number in its one form', !!cust && cust.name === 'Priya Walkin', JSON.stringify(cust));
  const afterB = await counts();
  check('one order, one customer, two payments, one dispatch', afterB.orders === beforeB.orders + 1 && afterB.customers === beforeB.customers + 1 && afterB.payments === beforeB.payments + 2 && afterB.dispatches === beforeB.dispatches + 1, `${JSON.stringify(beforeB)} -> ${JSON.stringify(afterB)}`);
  check('stock comes off the shelf once, and nothing is left held', same(await stockOf(saree.id, storeA.id), { onHand: 18, reserved: 0 }) && same(await stockOf(blouse.id, storeA.id), { onHand: 2, reserved: 0 }), JSON.stringify([await stockOf(saree.id, storeA.id), await stockOf(blouse.id, storeA.id)]));
  const ledger = await prisma.salesLedger.findMany({ where: { clientId: CLIENT, salesOrderId: s1?.id } });
  check('the revenue row is the bill (4,500), cost 2,700', ledger.length === 1 && Number(ledger[0].revenue) === 4500 && Number((ledger[0] as any).costOfGoods) === 2700, JSON.stringify(ledger));
  const order1 = await prisma.salesOrder.findFirst({ where: { id: s1?.id } });
  check('the order records who and how', order1?.createdById === sales.id && order1?.handover === 'TAKEN_NOW' && order1?.customerPhone === `+91${newPhone}`, JSON.stringify(order1));
  const usedQuote = await prisma.pricingQuote.findFirst({ where: { id: q1.quoteId } });
  check('the quote is spent on this order', !!usedQuote?.consumedAt, JSON.stringify(usedQuote));
  await new Promise(r => setTimeout(r, 1500));
  const audit = await prisma.auditLog.findFirst({ where: { clientId: CLIENT, entityId: s1?.id } });
  check('the activity feed names the order, not the route', !!audit && audit.action === 'COUNTER_SALE', JSON.stringify(audit));
  const receipt = await sales.api.get(`/counter-sales/${s1?.id}/receipt`);
  check('the receipt can be read again', receipt.status === 200 && receipt.data.data.orderNumber === s1?.orderNumber && noCost(receipt), brief(receipt));

  // ── C ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. THE SAME SALE AGAIN');
  const beforeC = await counts();
  const again = await sell(sales.api, body1);
  check('pressing Complete again gives back the same sale (200, replayed)', again.status === 200 && again.data.replayed === true && again.data.data.id === s1?.id, brief(again));
  check('...and changes nothing', same(await counts(), beforeC), JSON.stringify(await counts()));
  const otherBasket = await sell(sales.api, { ...body1, items: [{ variantId: saree.id, quantity: 1 }] });
  check('the same sale id with a different basket is refused (409)', otherBasket.status === 409 && otherBasket.data.details?.code === 'SALE_ALREADY_COMPLETED', brief(otherBasket));
  const qRace = await quote(sales.api, storeA.id, [{ variantId: saree.id, quantity: 1 }]);
  const raceBody = { saleId: crypto.randomUUID(), locationId: storeA.id, quoteId: qRace.quoteId, customer: { id: cust!.id }, items: [{ variantId: saree.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 1000 }] };
  const beforeRace = await counts();
  const race = await Promise.all([sell(sales.api, raceBody), sell(sales.api, raceBody)]);
  const afterRace = await counts();
  check('two presses at the same moment: one sale, both told about it', race.every(r => r.status === 200 || r.status === 201) && race[0].data?.data?.id === race[1].data?.data?.id, race.map(brief).join(' | '));
  check('...one order, one payment, one piece off the shelf', afterRace.orders === beforeRace.orders + 1 && afterRace.payments === beforeRace.payments + 1 && (await stockOf(saree.id, storeA.id)).onHand === 17, `${JSON.stringify(beforeRace)} -> ${JSON.stringify(afterRace)}`);

  // ── D ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. REFUSED, AND NOTHING LEFT BEHIND');
  const lastNumber = (await prisma.salesOrder.findFirst({ where: { clientId: CLIENT }, orderBy: { createdAt: 'desc' } }))!.orderNumber;
  const refuse = async (label: string, api: AxiosInstance, body: any, status: number, test: (r: any) => boolean) => {
    const before = await counts();
    const stock = [await stockOf(saree.id, storeA.id), await stockOf(blouse.id, storeA.id)];
    const r = await sell(api, body);
    const after = await counts();
    const stockAfter = [await stockOf(saree.id, storeA.id), await stockOf(blouse.id, storeA.id)];
    check(`${label} (${status})`, r.status === status && test(r) && noLeak(r), brief(r));
    check(`  ...and nothing was saved`, same(before, after) && same(stock, stockAfter), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  };
  const fresh = async (lines: { variantId: string; quantity: number }[], extra: any = {}) => {
    const q = await quote(sales.api, storeA.id, lines);
    return { saleId: crypto.randomUUID(), locationId: storeA.id, quoteId: q.quoteId, customer: { phone: phone(2), name: 'Should Not Exist' }, items: lines, ...extra };
  };
  const one = [{ variantId: saree.id, quantity: 1 }];
  await refuse('paying less than the bill', sales.api, await fresh(one, { payments: [{ method: 'UPI', amount: 900 }] }), 400, r => /still to be paid/i.test(r.data.message) && r.data.details?.code === 'PAYMENT_MISMATCH');
  await refuse('paying more than the bill by UPI', sales.api, await fresh(one, { payments: [{ method: 'UPI', amount: 1100 }] }), 400, r => /more than/i.test(r.data.message));
  await refuse('no payment at all', sales.api, await fresh(one, { payments: [] }), 400, r => /payment/i.test(r.data.message));
  await refuse('change on a UPI payment', sales.api, await fresh(one, { payments: [{ method: 'UPI', amount: 1000, cashReceived: 2000 }] }), 400, r => /only cash/i.test(r.data.message));
  await refuse('cash received less than the cash amount', sales.api, await fresh(one, { payments: [{ method: 'CASH', amount: 1000, cashReceived: 500 }] }), 400, r => /less than/i.test(r.data.message));
  await refuse('two cash rows', sales.api, await fresh(one, { payments: [{ method: 'CASH', amount: 500 }, { method: 'CASH', amount: 500 }] }), 400, r => /one row/i.test(r.data.message));
  await refuse('a card number typed as the reference', sales.api, await fresh(one, { payments: [{ method: 'CARD', amount: 1000, reference: '4111 1111 1111 1111' }] }), 400, r => /card number/i.test(r.data.message));
  await refuse('a price sent by the screen', sales.api, await fresh(one, { items: [{ variantId: saree.id, quantity: 1, unitPrice: 1 }], payments: [{ method: 'CASH', amount: 1 }] }), 400, () => true);
  await refuse('a channel sent by the screen', sales.api, await fresh(one, { channel: 'ONLINE', payments: [{ method: 'CASH', amount: 1000 }] }), 400, () => true);
  await refuse('more than the store has', sales.api, await fresh([{ variantId: blouse.id, quantity: 5 }], { payments: [{ method: 'CASH', amount: 12500 }] }), 409, r => r.data.details?.code === 'OUT_OF_STOCK' && r.data.details?.available === 2 && /Cotton Blouse/.test(r.data.message) && /Main Store/.test(r.data.message));
  await refuse('an item with none on the shelf', sales.api, await fresh([{ variantId: sareeBlue.id, quantity: 1 }], { payments: [{ method: 'CASH', amount: 1000 }] }), 409, r => r.data.details?.available === 0);
  const expired = await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] });
  await prisma.pricingQuote.update({ where: { id: expired.quoteId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await refuse('a price that has expired', sales.api, expired, 409, r => r.data.details?.code === 'PRICE_CHANGED');
  const changed = await fresh(one, { payments: [{ method: 'CASH', amount: 2000 }] });
  await refuse('a basket changed after pricing', sales.api, { ...changed, items: [{ variantId: saree.id, quantity: 2 }] }, 409, r => r.data.details?.code === 'PRICE_CHANGED');
  const usedQ = await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] });
  usedQ.quoteId = q1.quoteId;
  await refuse('a price already used on another sale', sales.api, usedQ, 409, r => r.data.details?.code === 'PRICE_CHANGED');
  await refuse('a closed store', sales.api, { ...(await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] })), locationId: closed.id }, 400, r => /closed/i.test(r.data.message));
  await refuse('a new customer with no name', sales.api, { ...(await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] })), customer: { phone: phone(3) } }, 400, r => /name/i.test(r.data.message));
  await refuse('a fake phone number', sales.api, { ...(await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] })), customer: { phone: '9999999999', name: 'Fake' } }, 400, r => /real number/i.test(r.data.message));
  const foreignCustomer = await prisma.customer.create({ data: { clientId: OTHER, customerCode: 'CUS-O-1', name: 'Other Shop', phone: `+91${phone(4)}`, status: 'ACTIVE' } });
  await refuse('another shop\'s customer', sales.api, { ...(await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] })), customer: { id: foreignCustomer.id } }, 404, () => true);
  await refuse('the stock room role', stockRoom.api, await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] }), 403, () => true);
  const nextOk = await sell(sales.api, { ...(await fresh(one, { payments: [{ method: 'CARD', amount: 1000, reference: '4242' }] })), customer: { phone: `+91 ${newPhone}`, name: 'Typed Differently' } });
  const n = (s: string) => Number(s.replace(/\D/g, ''));
  check('after all those refusals, the next sale takes the very next order number', nextOk.status === 201 && n(nextOk.data.data.orderNumber) === n(lastNumber) + 1, `${lastNumber} -> ${brief(nextOk)}`);
  check('a known number typed another way is that customer, not a new one', nextOk.data?.data?.customer?.id === cust!.id && nextOk.data.data.customer.name === 'Priya Walkin', brief(nextOk));
  check('a card\'s last four digits are kept as its reference', nextOk.data?.data?.payments?.[0]?.reference === '4242', brief(nextOk));
  check('no customer was left behind by the refused sales', !(await prisma.customer.findFirst({ where: { clientId: CLIENT, name: 'Should Not Exist' } })));

  const legacy = await prisma.customer.create({ data: { clientId: CLIENT, customerCode: `CUS-OLD-${STAMP}`, name: 'Old Regular', status: 'ACTIVE' } });
  await refuse('a customer saved before phones, with none given', sales.api, { ...(await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] })), customer: { id: legacy.id } }, 400, r => r.data.details?.code === 'CUSTOMER_NEEDS_PHONE');
  const legacyOk = await sell(sales.api, { ...(await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] })), customer: { id: legacy.id, phone: phone(5) } });
  const legacyAfter = await prisma.customer.findFirst({ where: { id: legacy.id } });
  check('...given one at the sale, the sale goes through and the number is saved', legacyOk.status === 201 && legacyAfter?.phone === `+91${phone(5)}`, brief(legacyOk));
  await refuse('...giving an old customer a number somebody else has', sales.api, { ...(await fresh(one, { payments: [{ method: 'CASH', amount: 1000 }] })), customer: { id: (await prisma.customer.create({ data: { clientId: CLIENT, customerCode: `CUS-OLD2-${STAMP}`, name: 'Old Two', status: 'ACTIVE' } })).id, phone: newPhone } }, 409, r => r.data.details?.code === 'PHONE_TAKEN' && r.data.details?.existingCustomerId === cust!.id);

  // ── E ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nE. MONEY OFF BY HAND');
  const withManual = async (api: AxiosInstance, amount: number, reason: string, pay: number) => {
    const q = await quote(api, storeA.id, one);
    return sell(api, { saleId: crypto.randomUUID(), locationId: storeA.id, quoteId: q.quoteId, customer: { id: cust!.id }, items: [{ variantId: saree.id, quantity: 1, manualDiscount: { amount, reason } }], payments: [{ method: 'CASH', amount: pay }] });
  };
  const within = await withManual(sales.api, 100, 'Small mark near the border', 900);
  check('10% off with a reason, within the till limit: sold at 900', within.status === 201 && within.data.data.total === 900 && within.data.data.discounts.some((d: any) => d.source === 'MANUAL' && d.title === 'Small mark near the border'), brief(within));
  const beforeOver = await counts();
  const over = await withManual(sales.api, 200, 'Customer asked nicely', 800);
  check('20% off by a salesperson is refused (403), naming the limit', over.status === 403 && /10%/.test(over.data.message), brief(over));
  check('  ...and nothing was saved', same(beforeOver, await counts()));
  const noReason = await withManual(sales.api, 50, 'na', 950);
  check('"na" is not a reason (400)', noReason.status === 400, brief(noReason));
  const noPerm = await withManual(cashierNoDiscount.api, 50, 'Loyal customer', 950);
  check('a cashier without the discount permission is refused (403)', noPerm.status === 403 && noPerm.data.requiredPermission === 'offer:manual_discount', brief(noPerm));
  const cashierPlain = await sell(cashierNoDiscount.api, { saleId: crypto.randomUUID(), locationId: storeA.id, quoteId: (await quote(cashierNoDiscount.api, storeA.id, one)).quoteId, customer: { id: cust!.id }, items: one, payments: [{ method: 'CASH', amount: 1000, cashReceived: 2000 }] });
  check('...but can sell at the price (the counter permission alone is enough)', cashierPlain.status === 201, brief(cashierPlain));
  const manager = await withManual(owner.api, 300, 'Festival goodwill, approved', 700);
  check('a manager may take off more than the till limit', manager.status === 201 && manager.data.data.total === 700, brief(manager));

  // ── F ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nF. THE OLDER ORDER ROUTE');
  const cheap = await sales.api.post('/sales-orders/full', { locationId: storeA.id, customer: { id: cust!.id }, items: [{ variantId: saree.id, quantity: 1, unitPrice: 1 }] });
  check('a salesperson sending their own lower price is refused (403)', cheap.status === 403 && /discount by hand/i.test(cheap.data.message), brief(cheap));
  const billOff = await sales.api.post('/sales-orders/full', { locationId: storeA.id, customer: { id: cust!.id }, discountAmount: 500, items: [{ variantId: saree.id, quantity: 1 }] });
  check('...or money off the bill with no reason (403)', billOff.status === 403, brief(billOff));
  const atPrice = await sales.api.post('/sales-orders/full', { locationId: storeA.id, customer: { id: cust!.id }, items: [{ variantId: saree.id, quantity: 1, unitPrice: 1000 }] });
  check('...the catalogue price itself is fine (201), and the order says who made it', atPrice.status === 201 && (await prisma.salesOrder.findFirst({ where: { id: atPrice.data.id } }))?.createdById === sales.id, brief(atPrice));
  await new Promise(r => setTimeout(r, 1500));
  check('...and the activity feed has the order id, not "full"', !!(await prisma.auditLog.findFirst({ where: { clientId: CLIENT, entityId: atPrice.data?.id, action: 'CREATED' } })));
  const ownerCheap = await owner.api.post('/sales-orders/full', { locationId: storeA.id, customer: { id: cust!.id }, items: [{ variantId: saree.id, quantity: 1, unitPrice: 800 }] });
  check('a manager may still set a price (201)', ownerCheap.status === 201, brief(ownerCheap));
  const foreignLoc = await owner.api.post('/sales-orders/full', { locationId: foreignStore.id, customer: { id: cust!.id }, items: [{ variantId: saree.id, quantity: 1 }] });
  check('an order at another shop\'s store is refused (404)', foreignLoc.status === 404, brief(foreignLoc));
  const foreignCust = await owner.api.post('/sales-orders/full', { locationId: storeA.id, customer: { id: foreignCustomer.id }, items: [{ variantId: saree.id, quantity: 1 }] });
  check('an order for another shop\'s customer is refused (404)', foreignCust.status === 404, brief(foreignCust));

  // ── G ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nG. CANCELLING');
  const place = async (qty: number) => salesOrderService.createFullOrder(CLIENT, storeA.id, { customer: { id: cust!.id }, status: 'CONFIRMED', items: [{ variantId: saree.id, quantity: qty }] }) as any;
  const s0 = await stockOf(saree.id, storeA.id);
  const whole = await place(3);
  check('confirming holds 3', (await stockOf(saree.id, storeA.id)).reserved === s0.reserved + 3);
  const cancelled: any = await salesOrderService.cancelOrder(CLIENT, whole.id);
  check('cancelling before anything went out: CANCELLED, all 3 released', cancelled.status === 'CANCELLED' && same(await stockOf(saree.id, storeA.id), s0), JSON.stringify(await stockOf(saree.id, storeA.id)));
  const part = await place(3);
  await dispatchService.createDispatch(CLIENT, part.id, [{ salesOrderItemId: part.items[0].id, quantity: 1 }]);
  const closedShort: any = await salesOrderService.cancelOrder(CLIENT, part.id);
  const s1b = await stockOf(saree.id, storeA.id);
  check('cancelling after 1 of 3 went out closes the rest: DISPATCHED', closedShort.status === 'DISPATCHED', closedShort.status);
  check('  ...the 2 left are released, the 1 sold stays off the shelf', s1b.reserved === s0.reserved && s1b.onHand === s0.onHand - 1, `${JSON.stringify(s0)} -> ${JSON.stringify(s1b)}`);
  check('  ...and its revenue is still counted', (await prisma.salesLedger.count({ where: { salesOrderId: part.id } })) === 1);
  const cancelDone = await salesOrderService.cancelOrder(CLIENT, part.id).then(() => 'ok', (e: any) => e.statusCode);
  check('  ...a sold order cannot be cancelled after that (409)', cancelDone === 409, String(cancelDone));
  const soldAtCounter = await owner.api.post(`/sales-orders/${s1?.id}/cancel`);
  check('a counter sale cannot be cancelled (409) -- it is a return', soldAtCounter.status === 409, brief(soldAtCounter));
  const twice = await place(2);
  const pair = await Promise.allSettled([salesOrderService.cancelOrder(CLIENT, twice.id), salesOrderService.cancelOrder(CLIENT, twice.id)]);
  check('two cancels at once: one wins, one is told it changed', pair.filter(p => p.status === 'fulfilled').length === 1, pair.map(p => p.status).join());
  check('  ...and the stock is released once, not twice', same(await stockOf(saree.id, storeA.id), s1b), JSON.stringify(await stockOf(saree.id, storeA.id)));

  // ── H ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nH. DISPATCH REFUSALS');
  const d = await place(2);
  const dup = await dispatchService.createDispatch(CLIENT, d.id, [{ salesOrderItemId: d.items[0].id, quantity: 1 }, { salesOrderItemId: d.items[0].id, quantity: 1 }]).then(() => 'ok', (e: any) => e.statusCode);
  check('the same line twice in one dispatch is refused (400)', dup === 400, String(dup));
  const none = await dispatchService.createDispatch(CLIENT, d.id, []).then(() => 'ok', (e: any) => e.statusCode);
  check('a dispatch of nothing is refused (400)', none === 400, String(none));
  const zero = await dispatchService.createDispatch(CLIENT, d.id, [{ salesOrderItemId: d.items[0].id, quantity: 0 }]).then(() => 'ok', (e: any) => e.statusCode);
  check('a dispatch of zero pieces is refused (400)', zero === 400, String(zero));
  const notOnOrder = await dispatchService.createDispatch(CLIENT, d.id, [{ salesOrderItemId: part.items[0].id, quantity: 1 }]).then(() => 'ok', (e: any) => e.statusCode);
  check('an item from another order is refused (404)', notOnOrder === 404, String(notOnOrder));
  await salesOrderService.cancelOrder(CLIENT, d.id);
  const afterCancel = await dispatchService.createDispatch(CLIENT, d.id, [{ salesOrderItemId: d.items[0].id, quantity: 1 }]).then(() => 'ok', (e: any) => e.statusCode);
  check('nothing can be sent out against a cancelled order (409)', afterCancel === 409, String(afterCancel));

  // ── I ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nI. DELETING THE SHOP');
  const preview: any = await platformAdminService.previewClientDeletion(CLIENT);
  check('the delete preview counts the payments', preview.payments >= 8, JSON.stringify(preview));
}

async function cleanup() {
  await platformAdminService.deleteClientCompletely(CLIENT, CLIENT).then(
    () => check('the shop, with its payments, is deleted completely', true),
    (e: any) => check('the shop, with its payments, is deleted completely', false, e?.message)
  );
  await prisma.customer.deleteMany({ where: { clientId: OTHER } }).catch(() => {});
  await prisma.stockLocation.deleteMany({ where: { clientId: OTHER } }).catch(() => {});
  const left = await prisma.salesOrderPayment.count({ where: { clientId: CLIENT } });
  check('no payment rows left behind', left === 0, String(left));
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
