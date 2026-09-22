/**
 * RETURNS AT THE COUNTER, STORE CREDIT AND EXCHANGES, worst cases included.
 *
 *   A  the shop's rules: days allowed, the most a salesperson pays back; who may set them
 *   B  finding the bill: by bill number, by its digits, by phone, by name; nobody else's bills
 *   C  what it comes to: the price paid after discounts, never the tag; too many pieces refused
 *   D  taking it back for cash: one press does it all, at the store it is handed back at; the
 *      money is recorded; pressed twice is one return
 *   E  damaged pieces do not go back on sale
 *   F  store credit: given on a return, spent at New sale, never below zero, two tills at once
 *   G  exchange: the returned value becomes credit and pays for the new pieces; the difference is
 *      paid, or stays as credit, or is paid out by a manager
 *   H  the rules bite a salesperson, never a manager
 *   I  a bill paid partly with loyalty points: that share goes back as points, not money
 *   J  a return finished the long way: record how the money went back, once
 *   K  the Day Book: money taken and paid back, and the cash that should be in the drawer
 *   L  another shop can do none of it
 *
 *   npx tsx src/scripts/verify-counter-returns.ts     (needs the local backend running)
 */
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { returnService } from '../services/return.service';
import { whatsappClient } from '../services/whatsapp/client';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `cret-${STAMP}`;
const OTHER = `cret-other-${STAMP}`;

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  ok   ${name}`); }
  else {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    failures.push(`${name} :: ${text}`);
    console.log(`  FAIL ${name} :: ${text}`);
  }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`;
const plain = (m: unknown) => typeof m === 'string' && /[a-z]{3}/i.test(m) && !/prisma|Invalid `|constraint|P20\d\d|undefined|NaN/i.test(m);
const api = (token: string, locationId?: string): AxiosInstance => axios.create({
  baseURL: BASE, headers: { Authorization: `Bearer ${token}`, ...(locationId ? { 'x-location-id': locationId } : {}) }, validateStatus: () => true, timeout: 120_000
});
const ok2 = (r: any) => r.status === 200 || r.status === 201;

// Never a real WhatsApp message from this suite.
(whatsappClient as any).send = async () => { throw new Error('no WhatsApp in this suite'); };

async function person(clientId: string, name: string, roleId: string, locationId?: string) {
  const u = await prisma.user.create({ data: { clientId, email: `cret-${name.toLowerCase().replace(/\s/g, '')}-${clientId}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  const token = AuthService.generateToken({ userId: u.id, clientId });
  return { id: u.id, name, http: api(token, locationId), token };
}

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const otherRoles = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Sree Silks' } });
  const storeA = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const storeB = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Branch', code: 'BR', type: 'STORE', active: true } });
  const owner = await person(SHOP, 'Owner', roles.SUPER_ADMIN, storeA.id);
  const sita = await person(SHOP, 'Sita Counter', roles.SALES, storeA.id);
  const sitaAtB = api(sita.token, storeB.id);
  const packer = await person(SHOP, 'Packer', roles.WAREHOUSE, storeA.id);
  const stranger = await person(OTHER, 'Stranger', otherRoles.SUPER_ADMIN);
  const own = owner.http;

  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Silk Saree', productCode: `CR-${STAMP}`, slug: `cr-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } });
  const mk = (sku: string, colour: string, price: number) => prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, sku: `${sku}-${STAMP}`, variantCode: `V-${sku}-${STAMP}`, colorName: colour, size: 'Free', sellingPrice: price, costPrice: price * 0.6, averageCost: price * 0.6 } });
  const red = await mk('RED', 'Red', 1000);
  const gold = await mk('GOLD', 'Gold', 3000);
  for (const [v, loc] of [[red, storeA], [gold, storeA], [red, storeB], [gold, storeB]] as const) {
    await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: v.id, locationId: loc.id, quantity: 50 } });
  }
  const stock = async (variantId: string, locationId: string) => (await prisma.inventoryStock.findFirstOrThrow({ where: { variantId, locationId } })).quantity;

  const quote = async (http: AxiosInstance, lines: { variantId: string; quantity: number }[], locationId = storeA.id) => {
    const r = await http.post('/pricing/quote', { locationId, channel: 'POS', lines });
    if (r.status !== 200) throw new Error(`quote failed: ${brief(r)}`);
    return r.data.data.quoteId as string;
  };
  const sell = async (http: AxiosInstance, lines: { variantId: string; quantity: number }[], customer: any, payments: any[], extra: any = {}) =>
    http.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: storeA.id, quoteId: await quote(http, lines), customer, items: lines, payments, ...extra });
  const phone = (n: number) => `+91 9${String(STAMP).slice(-5)}${String(n).padStart(4, '0')}`;
  const credit = async (customerId: string) => (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).storeCreditPaise / 100;

  try {
    // ── A ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nA. THE SHOP\'S RULES');
    const r0 = await sita.http.get('/counter-returns/rules');
    check('by default: no day limit and no money limit', r0.status === 200 && r0.data.data.returnWindowDays === null && r0.data.data.counterReturnMax === null, brief(r0));
    const rs = await sita.http.put('/counter-returns/rules', { returnWindowDays: 7 });
    check('a salesperson cannot change the rules', rs.status === 403, brief(rs));
    for (const [body, what] of [[{ returnWindowDays: -1 }, 'minus days'], [{ returnWindowDays: 2.5 }, 'half a day'], [{ counterReturnMax: 'lots' }, 'a word for money'], [{ counterReturnMax: 10.555 }, 'three decimals']] as const) {
      const r = await own.put('/counter-returns/rules', body);
      check(`refused in words: ${what}`, r.status === 400 && plain(r.data.message), brief(r));
    }

    // ── B ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nB. FINDING THE BILL');
    const lakshmiPhone = phone(1);
    const s1 = await sell(sita.http, [{ variantId: red.id, quantity: 3 }], { phone: lakshmiPhone, name: 'Lakshmi Devi' }, [{ method: 'CASH', amount: 2700 }],
      { manualDiscount: { amount: 300, reason: 'Festival' } });
    check('a sale of 3 sarees at ₹1,000 with ₹300 off the bill: ₹2,700', ok2(s1) && s1.data.data.total === 2700, brief(s1));
    const bill = s1.data.data;
    const lakshmi = await prisma.customer.findFirstOrThrow({ where: { clientId: SHOP, name: 'Lakshmi Devi' } });
    const byNumber = await sita.http.get('/counter-returns/find', { params: { q: bill.orderNumber } });
    check('a salesperson finds it by bill number', byNumber.status === 200 && byNumber.data.data[0]?.id === bill.id, brief(byNumber));
    const digits = bill.orderNumber.replace(/\D/g, '').replace(/^0+/, '');
    const byDigits = await sita.http.get('/counter-returns/find', { params: { q: digits.length >= 4 ? digits : bill.orderNumber } });
    check('  ...and by the number on its own', byDigits.data.data.some((s: any) => s.id === bill.id), brief(byDigits));
    const byPhone = await sita.http.get('/counter-returns/find', { params: { q: lakshmiPhone } });
    check('  ...by the customer\'s phone', byPhone.data.data.some((s: any) => s.id === bill.id), brief(byPhone));
    const byName = await sita.http.get('/counter-returns/find', { params: { q: 'lakshmi' } });
    check('  ...by the customer\'s name', byName.data.data.some((s: any) => s.id === bill.id), brief(byName));
    const line = byNumber.data.data[0].lines[0];
    check('the bill shows each line with what can still come back and what was paid for one (₹900)', line.canReturn === 3 && line.paidEach === 900, JSON.stringify(line));
    const tooShort = await sita.http.get('/counter-returns/find', { params: { q: 'a' } });
    check('one letter is not a search', tooShort.status === 400 && plain(tooShort.data.message), brief(tooShort));
    const theirs = await stranger.http.get('/counter-returns/find', { params: { q: bill.orderNumber } });
    check('another shop finds nothing of ours, even by the same bill number', theirs.status === 200 && !theirs.data.data.some((s: any) => s.id === bill.id), brief(theirs));

    // ── C ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nC. WHAT IT COMES TO');
    const pv = await sita.http.post('/counter-returns/preview', { orderId: bill.id, lines: [{ dispatchItemId: line.dispatchItemId, quantity: 1 }] });
    check('1 of the 3 comes to ₹900 (what was paid), not the ₹1,000 tag', pv.status === 200 && pv.data.data.money === 900 && pv.data.data.needsManager === null, brief(pv));
    const tooMany = await sita.http.post('/counter-returns/preview', { orderId: bill.id, lines: [{ dispatchItemId: line.dispatchItemId, quantity: 4 }] });
    check('4 of 3 is refused, saying how many can come back', tooMany.status === 409 && /3/.test(tooMany.data.message), brief(tooMany));

    // ── D ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nD. TAKING IT BACK FOR CASH');
    const key = crypto.randomUUID();
    const body = { key, orderId: bill.id, lines: [{ dispatchItemId: line.dispatchItemId, quantity: 1, condition: 'RESTOCK' }], reason: 'SIZE_ISSUE', refund: { method: 'CASH' } };
    const noWay = await sitaAtB.post('/counter-returns', { ...body, key: crypto.randomUUID(), refund: null });
    check('without saying how the money goes back, nothing is recorded', noWay.status === 400 && /cash, UPI, card or store credit/.test(noWay.data.message) && (await prisma.salesReturn.count({ where: { clientId: SHOP } })) === 0, brief(noWay));
    const aBefore = await stock(red.id, storeA.id), bBefore = await stock(red.id, storeB.id);
    const d1 = await sitaAtB.post('/counter-returns', body);
    check('a salesperson at the branch takes 1 back for cash in one press', d1.status === 201 && d1.data.data.money === 900 && d1.data.data.refundWords === '₹900 in cash', brief(d1));
    const ret1 = await prisma.salesReturn.findUniqueOrThrow({ where: { id: d1.data.data.returnId } });
    check('  ...the return is complete, marked as taken at the counter, at the branch', ret1.status === 'COMPLETED' && ret1.atCounter && ret1.locationId === storeB.id && ret1.refundStatus === 'REFUNDED' && ret1.refundMethod === 'CASH', JSON.stringify(ret1));
    check('  ...the piece went back on sale at the branch where it was handed in, not the store that sold it', await stock(red.id, storeB.id) === bBefore + 1 && await stock(red.id, storeA.id) === aBefore);
    const refundRow = await prisma.salesOrderPayment.findFirst({ where: { salesReturnId: ret1.id } });
    check('  ...₹900 cash paid back is recorded against the bill, at the branch, by Sita', refundRow?.kind === 'REFUND' && refundRow.method === 'CASH' && Number(refundRow.amount) === 900 && refundRow.locationId === storeB.id && refundRow.receivedById === sita.id, JSON.stringify(refundRow));
    const again = await sitaAtB.post('/counter-returns', body);
    check('pressed again: the same return, nothing twice', ok2(again) && again.data.data.replayed === true && again.data.data.returnId === ret1.id && (await prisma.salesOrderPayment.count({ where: { salesReturnId: ret1.id } })) === 1 && await stock(red.id, storeB.id) === bBefore + 1, brief(again));
    const race = await Promise.all([0, 1].map(() => sitaAtB.post('/counter-returns', { ...body, key: crypto.randomUUID(), lines: [{ dispatchItemId: line.dispatchItemId, quantity: 2 }] })));
    check('two counters taking the last 2 pieces at once: one return, never 4 pieces back', race.filter(ok2).length === 1 && (await prisma.dispatchItem.findUniqueOrThrow({ where: { id: line.dispatchItemId } })).returnedQty === 3, race.map(brief).join(' | '));
    const sameKeyOther = await own.post('/counter-returns', { ...body, orderId: crypto.randomUUID() });
    check('the same key used for another bill is refused', sameKeyOther.status === 409 || sameKeyOther.status === 404, brief(sameKeyOther));
    const orderView = await own.get(`/counter-sales/${bill.id}/receipt`);
    check('the bill now shows ₹2,700 paid and ₹2,700 paid back', orderView.data.data.payment.refunded === 2700 && orderView.data.data.payment.paid === 2700, JSON.stringify(orderView.data.data.payment));

    // ── E ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nE. DAMAGED');
    const s2 = await sell(sita.http, [{ variantId: red.id, quantity: 1 }], { id: lakshmi.id }, [{ method: 'UPI', amount: 1000, reference: 'UTR9' }]);
    const bill2 = s2.data.data;
    const l2 = (await sita.http.get(`/counter-returns/sale/${bill2.id}`)).data.data.lines[0];
    const aB = await stock(red.id, storeA.id);
    const d2 = await sita.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: bill2.id, lines: [{ dispatchItemId: l2.dispatchItemId, quantity: 1, condition: 'DAMAGED' }], reason: 'DEFECTIVE', refund: { method: 'UPI', reference: 'UTR-BACK' } });
    check('a damaged piece: money back in UPI with its reference, and it does not go back on sale', d2.status === 201 && await stock(red.id, storeA.id) === aB && (await prisma.salesOrderPayment.findFirst({ where: { salesReturnId: d2.data.data.returnId } }))?.reference === 'UTR-BACK', brief(d2));
    const card = await sita.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: bill2.id, lines: [{ dispatchItemId: l2.dispatchItemId, quantity: 1 }], reason: 'OTHER', refund: { method: 'CARD', reference: '4111 1111 1111 1111' } });
    check('a full card number as the reference is refused', card.status === 400 || card.status === 409, brief(card));

    // ── F ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nF. STORE CREDIT');
    const s3 = await sell(sita.http, [{ variantId: red.id, quantity: 2 }], { id: lakshmi.id }, [{ method: 'CASH', amount: 2000 }]);
    const bill3 = s3.data.data;
    const l3 = (await sita.http.get(`/counter-returns/sale/${bill3.id}`)).data.data.lines[0];
    const d3 = await sita.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: bill3.id, lines: [{ dispatchItemId: l3.dispatchItemId, quantity: 2 }], reason: 'CUSTOMER_REJECTED', refund: { method: 'CREDIT' } });
    check('2 pieces back as store credit: she holds ₹2,000', d3.status === 201 && await credit(lakshmi.id) === 2000 && d3.data.data.customer.storeCredit === 2000, brief(d3));
    const hist = await sita.http.get(`/counter-returns/credit/customers/${lakshmi.id}`);
    check('  ...her store credit history says where it came from', hist.status === 200 && hist.data.data.credit === 2000 && hist.data.data.entries[0].label === 'From a return' && hist.data.data.entries[0].returnNumber, brief(hist));
    const counterCredit = await sita.http.get('/counter-returns/credit/counter', { params: { customerId: lakshmi.id } });
    check('  ...New sale sees ₹2,000 of credit', counterCredit.data.data.credit === 2000, brief(counterCredit));
    const over = await sell(sita.http, [{ variantId: gold.id, quantity: 1 }], { id: lakshmi.id }, [{ method: 'CREDIT', amount: 2500 }, { method: 'CASH', amount: 500 }]);
    check('spending ₹2,500 of ₹2,000 credit is refused, saying what she has, and no sale is made', over.status === 400 && /₹2,000/.test(over.data.message) && await credit(lakshmi.id) === 2000, brief(over));
    const [qa, qb] = [await quote(sita.http, [{ variantId: red.id, quantity: 2 }]), await quote(own, [{ variantId: red.id, quantity: 2 }])];
    const race2 = await Promise.all([
      sita.http.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: storeA.id, quoteId: qa, customer: { id: lakshmi.id }, items: [{ variantId: red.id, quantity: 2 }], payments: [{ method: 'CREDIT', amount: 2000 }] }),
      own.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: storeA.id, quoteId: qb, customer: { id: lakshmi.id }, items: [{ variantId: red.id, quantity: 2 }], payments: [{ method: 'CREDIT', amount: 2000 }] })
    ]);
    check('two tills spending the same ₹2,000 credit at once: exactly one sale', race2.filter(ok2).length === 1 && await credit(lakshmi.id) === 0, race2.map(brief).join(' | '));
    const twoRows = await sell(sita.http, [{ variantId: red.id, quantity: 1 }], { id: lakshmi.id }, [{ method: 'CREDIT', amount: 500 }, { method: 'CREDIT', amount: 500 }]);
    check('store credit twice on one bill is refused', twoRows.status === 400 && /once/.test(twoRows.data.message), brief(twoRows));

    // ── G ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nG. EXCHANGE');
    const radhaPhone = phone(2);
    const s4 = await sell(sita.http, [{ variantId: red.id, quantity: 2 }], { phone: radhaPhone, name: 'Radha Krishna' }, [{ method: 'CASH', amount: 2000 }]);
    const bill4 = s4.data.data;
    const radha = await prisma.customer.findFirstOrThrow({ where: { clientId: SHOP, name: 'Radha Krishna' } });
    const l4 = (await sita.http.get(`/counter-returns/sale/${bill4.id}`)).data.data.lines[0];
    const ex = await sita.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: bill4.id, lines: [{ dispatchItemId: l4.dispatchItemId, quantity: 2 }], reason: 'SIZE_ISSUE', exchange: true, refund: { method: 'CASH' } });
    check('exchange: the 2 pieces\' ₹2,000 becomes credit (never cash, whatever the screen sent)', ex.status === 201 && ex.data.data.exchange === true && ex.data.data.refundMethod === 'CREDIT' && await credit(radha.id) === 2000, brief(ex));
    const dearer = await sell(sita.http, [{ variantId: gold.id, quantity: 1 }], { id: radha.id }, [{ method: 'CREDIT', amount: 2000 }, { method: 'UPI', amount: 1000 }]);
    check('  ...a ₹3,000 saree instead: ₹2,000 from the credit and the ₹1,000 difference in UPI', ok2(dearer) && await credit(radha.id) === 0 && dearer.data.data.payments.some((p: any) => p.method === 'CREDIT' && p.amount === 2000), brief(dearer));
    const s5 = await sell(sita.http, [{ variantId: gold.id, quantity: 1 }], { id: radha.id }, [{ method: 'CASH', amount: 3000 }]);
    const l5 = (await sita.http.get(`/counter-returns/sale/${s5.data.data.id}`)).data.data.lines[0];
    await sita.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: s5.data.data.id, lines: [{ dispatchItemId: l5.dispatchItemId, quantity: 1 }], reason: 'CUSTOMER_REJECTED', exchange: true });
    const cheaper = await sell(sita.http, [{ variantId: red.id, quantity: 1 }], { id: radha.id }, [{ method: 'CREDIT', amount: 1000 }]);
    check('a cheaper saree in exchange for ₹3,000: ₹1,000 used, ₹2,000 stays as credit', ok2(cheaper) && await credit(radha.id) === 2000, brief(cheaper));
    const salesPay = await sita.http.post(`/counter-returns/credit/customers/${radha.id}/payout`, { amount: 2000, method: 'CASH', nonce: crypto.randomUUID() });
    check('a salesperson cannot pay credit out in cash', salesPay.status === 403, brief(salesPay));
    const nonce = crypto.randomUUID();
    const pay = await own.post(`/counter-returns/credit/customers/${radha.id}/payout`, { amount: 2000, method: 'CASH', nonce });
    const pay2 = await own.post(`/counter-returns/credit/customers/${radha.id}/payout`, { amount: 2000, method: 'CASH', nonce });
    check('the owner pays the ₹2,000 out in cash; the same press twice pays once', ok2(pay) && ok2(pay2) && await credit(radha.id) === 0 && (await prisma.storeCreditEntry.count({ where: { customerId: radha.id, kind: 'PAID_OUT' } })) === 1, `${brief(pay)} | ${brief(pay2)}`);
    const payMore = await own.post(`/counter-returns/credit/customers/${radha.id}/payout`, { amount: 1, method: 'CASH', nonce: crypto.randomUUID() });
    check('  ...and nothing more can be paid out than she holds', payMore.status === 400 && plain(payMore.data.message), brief(payMore));
    const books = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM customers c WHERE c.client_id = ${SHOP}
         AND c.store_credit_paise <> COALESCE((SELECT SUM(amount_paise) FROM store_credit_entries e WHERE e.customer_id = c.id), 0)`;
    check('every customer\'s store credit equals the sum of their entries', Number(books[0].n) === 0, String(books[0].n));

    // ── H ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nH. THE RULES');
    const set = await own.put('/counter-returns/rules', { returnWindowDays: 7, counterReturnMax: 1500 });
    check('the owner sets: 7 days, ₹1,500 without a manager', set.status === 200 && set.data.data.returnWindowDays === 7 && set.data.data.counterReturnMax === 1500, brief(set));
    const s6 = await sell(sita.http, [{ variantId: gold.id, quantity: 1 }], { id: lakshmi.id }, [{ method: 'CASH', amount: 3000 }]);
    const l6 = (await sita.http.get(`/counter-returns/sale/${s6.data.data.id}`)).data.data.lines[0];
    const pv6 = await sita.http.post('/counter-returns/preview', { orderId: s6.data.data.id, lines: [{ dispatchItemId: l6.dispatchItemId, quantity: 1 }] });
    check('₹3,000 back: the salesperson is told a manager is needed, and why', /manager/.test(pv6.data.data.needsManager ?? '') && /₹1,500/.test(pv6.data.data.needsManager), brief(pv6));
    const big = await sita.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: s6.data.data.id, lines: [{ dispatchItemId: l6.dispatchItemId, quantity: 1 }], reason: 'OTHER', refund: { method: 'CASH' } });
    check('  ...and cannot take it', big.status === 403 && /₹1,500/.test(big.data.message), brief(big));
    const s7 = await sell(sita.http, [{ variantId: red.id, quantity: 1 }], { id: lakshmi.id }, [{ method: 'CASH', amount: 1000 }]);
    await prisma.salesOrder.update({ where: { id: s7.data.data.id }, data: { createdAt: new Date(Date.now() - 10 * 86400000) } });
    const l7 = (await sita.http.get(`/counter-returns/sale/${s7.data.data.id}`)).data.data;
    check('a bill 10 days old shows as past the 7 days', l7.window?.over === true && l7.daysAgo === 10, JSON.stringify(l7.window));
    const late = await sita.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: s7.data.data.id, lines: [{ dispatchItemId: l7.lines[0].dispatchItemId, quantity: 1 }], reason: 'OTHER', refund: { method: 'CASH' } });
    check('  ...a salesperson cannot take it back', late.status === 403 && /10 days old/.test(late.data.message), brief(late));
    const mgr = await own.post('/counter-returns', { key: crypto.randomUUID(), orderId: s7.data.data.id, lines: [{ dispatchItemId: l7.lines[0].dispatchItemId, quantity: 1 }], reason: 'OTHER', refund: { method: 'CASH' } });
    check('  ...the owner can', mgr.status === 201, brief(mgr));
    await own.put('/counter-returns/rules', { returnWindowDays: null, counterReturnMax: null });

    // ── I ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nI. LOYALTY POINTS ON THE BILL');
    await own.put('/loyalty/settings', { enabled: true });
    await prisma.$transaction(tx => import('../services/loyalty').then(l => l.post(tx, { clientId: SHOP, customerId: lakshmi.id, kind: 'ADJUSTED', points: 500, onceKey: `SEED:${lakshmi.id}` })));
    const s8 = await sell(sita.http, [{ variantId: red.id, quantity: 2 }], { id: lakshmi.id }, [{ method: 'POINTS', amount: 400 }, { method: 'CASH', amount: 1600 }]);
    check('a ₹2,000 bill paid ₹400 in points and ₹1,600 in cash', ok2(s8), brief(s8));
    const l8 = (await sita.http.get(`/counter-returns/sale/${s8.data.data.id}`)).data.data.lines[0];
    const pv8 = await sita.http.post('/counter-returns/preview', { orderId: s8.data.data.id, lines: [{ dispatchItemId: l8.dispatchItemId, quantity: 1 }] });
    check('returning 1: ₹800 in money and 200 points (₹200) back, 8 earned points taken back', pv8.data.data.money === 800 && pv8.data.data.pointsBack === 200 && pv8.data.data.pointsTakenBack === 8, brief(pv8));
    const ptsBefore = (await prisma.customer.findUniqueOrThrow({ where: { id: lakshmi.id } })).loyaltyPoints;
    const d8 = await sita.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: s8.data.data.id, lines: [{ dispatchItemId: l8.dispatchItemId, quantity: 1 }], reason: 'SIZE_ISSUE', refund: { method: 'CASH' } });
    check('  ...taken back: exactly ₹800 cash recorded, and the points moved', d8.status === 201 && d8.data.data.money === 800 && Number((await prisma.salesOrderPayment.findFirst({ where: { salesReturnId: d8.data.data.returnId } }))!.amount) === 800
      && (await prisma.customer.findUniqueOrThrow({ where: { id: lakshmi.id } })).loyaltyPoints === ptsBefore + 200 - 8, brief(d8));

    // ── J ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nJ. A RETURN FINISHED THE LONG WAY');
    const s9 = await sell(sita.http, [{ variantId: red.id, quantity: 1 }], { id: lakshmi.id }, [{ method: 'CASH', amount: 1000 }]);
    const di9 = (await prisma.dispatchItem.findFirstOrThrow({ where: { dispatch: { salesOrderId: s9.data.data.id } } }));
    const r9: any = await returnService.createReturn(SHOP, s9.data.data.id, [{ dispatchItemId: di9.id, quantity: 1 }], 'parcel', 'OTHER' as any);
    const early = await packer.http.post(`/counter-returns/refund/${r9.id}`, { method: 'CASH' });
    check('money cannot be recorded before the return is finished', early.status === 409 && plain(early.data.message), brief(early));
    await returnService.inspectReturn(SHOP, r9.id, [{ salesReturnItemId: r9.items[0].id, disposition: 'RESTOCK' }]);
    await returnService.completeReturn(SHOP, r9.id);
    const rec = await packer.http.post(`/counter-returns/refund/${r9.id}`, { method: 'CREDIT' });
    check('finished: the ₹1,000 is recorded as store credit, and the return says refunded', ok2(rec) && (await prisma.salesReturn.findUniqueOrThrow({ where: { id: r9.id } })).refundStatus === 'REFUNDED' && await credit(lakshmi.id) === 1000, brief(rec));
    const rec2 = await packer.http.post(`/counter-returns/refund/${r9.id}`, { method: 'CASH' });
    check('  ...recording it again is refused: paid once', rec2.status === 409 && await credit(lakshmi.id) === 1000 && (await prisma.salesOrderPayment.count({ where: { salesReturnId: r9.id } })) === 1, brief(rec2));

    // ── K ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nK. THE DAY BOOK');
    const db = await own.get('/daybook', { params: { locationId: storeB.id } });
    const m = db.data.data?.money ?? db.data.money;
    check('the branch\'s Day Book: nothing taken there, ₹900 cash paid back, drawer -₹900', m && !m.taken.CASH && m.paidBack.CASH?.amount >= 900 && m.cashInDrawer === -m.paidBack.CASH.amount, JSON.stringify(m));
    const dbA = await own.get('/daybook', { params: { locationId: storeA.id } });
    const mA = dbA.data.data?.money ?? dbA.data.money;
    check('the main store\'s Day Book lists cash, UPI, points and store credit taken, and what went back', mA && mA.taken.CASH && mA.taken.UPI && mA.taken.POINTS && mA.taken.CREDIT && mA.paidBack.CASH && mA.paidBack.CREDIT
      && mA.cashInDrawer === Math.round((mA.taken.CASH.amount - mA.paidBack.CASH.amount) * 100) / 100, JSON.stringify(mA));

    // ── L ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nL. ANOTHER SHOP, AND ROLES');
    const peekSale = await stranger.http.get(`/counter-returns/sale/${bill.id}`);
    check('another shop cannot open our bill for a return', peekSale.status === 404, brief(peekSale));
    const theirReturn = await stranger.http.post('/counter-returns', { key: crypto.randomUUID(), orderId: bill2.id, locationId: storeA.id, lines: [{ dispatchItemId: l2.dispatchItemId, quantity: 1 }], reason: 'OTHER', refund: { method: 'CASH' } });
    check('  ...nor take our goods back', theirReturn.status === 404 || theirReturn.status === 400, brief(theirReturn));
    const theirCredit = await stranger.http.get(`/counter-returns/credit/customers/${lakshmi.id}`);
    check('  ...nor see a customer\'s store credit', theirCredit.status === 404, brief(theirCredit));
    const theirPay = await stranger.http.post(`/counter-returns/credit/customers/${lakshmi.id}/payout`, { amount: 100, method: 'CASH', nonce: crypto.randomUUID() });
    check('  ...nor pay it out', theirPay.status === 400 || theirPay.status === 404, brief(theirPay));
    const granted = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM roles r WHERE r.name = 'SALES'
         AND NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id AND p.key = 'return:counter')`;
    check('every shop\'s SALES role can now take returns at the counter', Number(granted[0].n) === 0, String(granted[0].n));
  } finally {
    await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
    await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch((e: any) => console.log('  (delete failed:', String(e?.message ?? e).slice(0, 300), ')'));
    const left = await prisma.storeCreditEntry.count({ where: { clientId: SHOP } }) + await prisma.salesReturn.count({ where: { clientId: SHOP } });
    check('the test shop is removed afterwards, store credit and returns too', left === 0, String(left));
  }

  console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
  if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
  process.exit(failures.length ? 1 : 0);
}

main().catch(async e => {
  console.error('\nSuite did not finish:', e?.stack ?? e);
  await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch(() => {});
  await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
  process.exit(1);
});
