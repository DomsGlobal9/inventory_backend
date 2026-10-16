/**
 * Gift vouchers, part A: everything that writes no VOUCHER payment row, so it is safe before the
 * deploy (the shared-DB enum rule). Real HTTP with a real till key, on a throwaway shop of its own.
 *
 *   A  switched off by default; the shop's rules and their limits
 *   B  selling: the code, the same key twice, amount limits, payments that must add up, cash / UPI /
 *      card only, bad references, a reference already on a bill or another voucher, the 269ST cash limit,
 *      the buyer linked by phone
 *   C  checking: usable against the bill, buyer's first name and masked phone, unknown / expired /
 *      blocked / used up in words, codes typed loosely, wrong-code guessing stopped
 *   D  the shop's side: list, search, filters, summary, extend (before expiry only), block / unblock
 *   E  the Day Book: sold by method, outside sales, cash in the drawer includes voucher cash
 *   F  permissions over HTTP: a role without voucher:view is refused
 *
 *   npx tsx src/scripts/verify-gift-vouchers.ts     (needs the local backend on :4006)
 *   Part B (spending, returns) is verify-gift-vouchers-spend.ts, run after the deploy.
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { posConnectionService } from '../services/pos/pos-connection.service';
import * as gv from '../services/gift-vouchers';
import { dayBookService } from '../services/daybook.service';
import { AuthService } from '../services/auth.service';

const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const C = `gv-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 260)}`;
const ans = (r: any) => r.data?.data?.answer;

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: C, name: 'Counter', code: `GV-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.clientSettings.create({ data: { clientId: C, businessName: 'Voucher Test Shop', gstRegistration: 'UNREGISTERED' } as any });
  const till = await posConnectionService.create(C, { locationId: store.id, name: 'Till one' });
  const till2 = await posConnectionService.create(C, { locationId: store.id, name: 'Till two' });
  const T = axios.create({ baseURL: `${API}/pos/v1`, headers: { 'X-Storefront-Key': till.key }, validateStatus: () => true });
  const T2 = axios.create({ baseURL: `${API}/pos/v1`, headers: { 'X-Storefront-Key': till2.key }, validateStatus: () => true });
  let k = 0;
  const sell = (body: any, http = T) => http.post('/vouchers', { idempotencyKey: `k-${STAMP}-${++k}`, ...body });
  const cash = (paise: number) => [{ method: 'CASH', amountPaise: paise }];

  console.log('\nA. RULES');
  const off = await sell({ amountPaise: 100000, payments: cash(100000) });
  check('switched off until the shop turns it on: refused in words', off.status === 422 && ans(off) === 'VOUCHERS_OFF', brief(off));
  check('the defaults: 12 months, ₹500 to ₹50,000', JSON.stringify(await gv.getSettings(C)) === JSON.stringify({ enabled: false, validMonths: 12, minPaise: 50000, maxPaise: 5000000 }));
  for (const [bad, why] of [[{ validMonths: 0 }, '0 months'], [{ validMonths: 61 }, '61 months'], [{ minPaise: 50 }, 'under ₹1'], [{ minPaise: 100000, maxPaise: 50000 }, 'largest below smallest'], [{ maxPaise: 2_00_00_00_000 }, 'over ₹10 lakh']] as const) {
    const e = await gv.saveSettings(C, bad, null).then(() => null, x => x);
    check(`a rule that makes no sense is refused (${why})`, e?.statusCode === 400, e?.message);
  }
  await gv.saveSettings(C, { enabled: true, validMonths: 12, minPaise: 50000, maxPaise: 5000000 }, 'tester');

  console.log('\nB. SELLING');
  const key = `same-${STAMP}`;
  const s1 = await T.post('/vouchers', { idempotencyKey: key, amountPaise: 500000, payments: [{ method: 'CASH', amountPaise: 300000 }, { method: 'UPI', amountPaise: 200000, reference: '612345678901' }], buyer: { name: 'Priya Reddy', phone: '98480 77711' } });
  const v1 = s1.data?.data;
  check('sold: a code GV-XXXX-XXXX with no 0 O 1 I, ₹5,000 balance, a year to spend it', s1.status === 200 && /^GV-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(v1?.code) && v1.balancePaise === 500000 && Math.round((new Date(v1.expiresAt).getTime() - Date.now()) / 86_400_000 / 30) === 12, brief(s1));
  const s1b = await T.post('/vouchers', { idempotencyKey: key, amountPaise: 999900, payments: cash(999900) });
  check('the same key again (a retry) is the same voucher, never a second one', s1b.data?.data?.code === v1?.code && await prisma.giftVoucher.count({ where: { clientId: C } }) === 1, brief(s1b));
  const both = await Promise.all([1, 2].map(() => T.post('/vouchers', { idempotencyKey: `race-${STAMP}`, amountPaise: 100000, payments: cash(100000) })));
  check('the same key twice at the same moment: one voucher', both[0].data?.data?.code === both[1].data?.data?.code && await prisma.giftVoucher.count({ where: { clientId: C, idempotencyKey: `race-${STAMP}` } }) === 1, both.map(brief));
  for (const [body, answer, why] of [
    [{ amountPaise: 40000, payments: cash(40000) }, 'AMOUNT', 'below the smallest'],
    [{ amountPaise: 6000000, payments: cash(6000000) }, 'AMOUNT', 'above the largest'],
    [{ amountPaise: 100000, payments: cash(90000) }, 'PAYMENTS_DONT_ADD_UP', 'payments short'],
    [{ amountPaise: 100000, payments: [{ method: 'CREDIT', amountPaise: 100000 }] }, 'BAD_PAYMENT', 'paid with store credit'],
    [{ amountPaise: 100000, payments: [{ method: 'VOUCHER', amountPaise: 100000 }] }, 'BAD_PAYMENT', 'a voucher paid with a voucher'],
    [{ amountPaise: 100000, payments: [{ method: 'CARD', amountPaise: 100000, reference: '4111 1111 1111 1111' }] }, 'BAD_REFERENCE', 'a full card number'],
    [{ amountPaise: 100000, payments: cash(100000), buyer: { phone: '12345' } }, 'BAD_PHONE', 'a broken phone']
  ] as const) {
    const r = await sell(body);
    check(`refused in words: ${why}`, r.status === 422 && ans(r) === answer && !!r.data?.data?.detail, brief(r));
  }
  const noPay = await sell({ amountPaise: 100000, payments: [] });
  check('no payments at all: refused (422)', noPay.status === 422, brief(noPay));
  const dupVoucher = await sell({ amountPaise: 100000, payments: [{ method: 'UPI', amountPaise: 100000, reference: '612345678901' }] });
  check('a UPI reference already on another voucher: 409 REFERENCE_USED', dupVoucher.status === 409 && ans(dupVoucher) === 'REFERENCE_USED', brief(dupVoucher));
  const cust = await prisma.customer.create({ data: { clientId: C, customerCode: `GC-${STAMP}`, name: 'Bill Payer' } });
  const order = await prisma.salesOrder.create({ data: { clientId: C, orderNumber: `SO-${STAMP}`, customerId: cust.id, channel: 'POS' as any, locationId: store.id, status: 'DISPATCHED' as any, subtotal: 1000, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total: 1000 } as any });
  await prisma.salesOrderPayment.create({ data: { clientId: C, salesOrderId: order.id, locationId: store.id, kind: 'PAYMENT', method: 'UPI', amount: 1000, reference: '698765432109' } as any });
  const dupBill = await sell({ amountPaise: 100000, payments: [{ method: 'UPI', amountPaise: 100000, reference: '698765432109' }] });
  check('a UPI reference already on a bill: 409 REFERENCE_USED', dupBill.status === 409 && ans(dupBill) === 'REFERENCE_USED', brief(dupBill));
  const twice = await sell({ amountPaise: 200000, payments: [{ method: 'UPI', amountPaise: 100000, reference: '611111111111' }, { method: 'UPI', amountPaise: 100000, reference: '611111111111' }] });
  check('the same reference on two payments of one voucher: refused', twice.status === 409 && ans(twice) === 'REFERENCE_USED', brief(twice));
  await gv.saveSettings(C, { maxPaise: 50_00_000 * 100 / 10 }, 'tester'); // ₹5,00,000 so the cash rule can be reached
  const bigCash = await sell({ amountPaise: 2_00_000 * 100, payments: cash(2_00_000 * 100) });
  check('₹2,00,000 in cash for one voucher: refused (269ST)', bigCash.status === 422 && ans(bigCash) === 'CASH_LIMIT', brief(bigCash));
  const justUnder = await sell({ amountPaise: 2_00_000 * 100, payments: [{ method: 'CASH', amountPaise: 1_99_999 * 100 }, { method: 'CARD', amountPaise: 100, reference: '1234/AB12C3' }] });
  check('₹1,99,999 cash plus the rest by card: allowed', justUnder.status === 200, brief(justUnder));
  await gv.saveSettings(C, { maxPaise: 5000000 }, 'tester');
  const known = await prisma.customer.create({ data: { clientId: C, customerCode: `GK-${STAMP}`, name: 'Meena Iyer', phone: '+919848077722' } });
  const s3 = await sell({ amountPaise: 200000, payments: cash(200000), buyer: { phone: '+91 98480 77722' } });
  const v3 = await prisma.giftVoucher.findFirst({ where: { clientId: C, code: s3.data?.data?.code } });
  check('a buyer the shop knows is linked by phone, and named from the record', v3?.buyerCustomerId === known.id && v3?.buyerName === 'Meena Iyer', v3);
  const soldEntry = await prisma.giftVoucherEntry.findFirst({ where: { clientId: C, kind: 'SOLD', voucherId: (await prisma.giftVoucher.findFirst({ where: { clientId: C, code: v1.code } }))!.id } });
  check('the sale is one SOLD entry with how it was paid and the store', soldEntry?.amountPaise === 500000 && JSON.stringify((soldEntry?.payments as any[])?.map(p => [p.method, p.amountPaise, p.reference])) === JSON.stringify([['CASH', 300000, null], ['UPI', 200000, '612345678901']]) && soldEntry?.locationId === store.id, soldEntry);

  console.log('\nC. CHECKING');
  const c1 = await T.get(`/vouchers/${v1.code}`, { params: { billPaise: 350000 } });
  check('usable on a ₹3,500 bill: ₹3,500 of ₹5,000; buyer "Priya" and a masked phone', c1.status === 200 && c1.data.data.usablePaise === 350000 && c1.data.data.balancePaise === 500000 && c1.data.data.buyerName === 'Priya' && /^\+91 98•+11$/.test(c1.data.data.buyerPhone) && c1.data.data.reason === null, brief(c1));
  const loose = await T.get(`/vouchers/${v1.code.toLowerCase().replace(/-/g, '').replace(/^gv/, '')}`);
  check('typed loosely (small letters, no dashes, no GV): still found', loose.data?.data?.code === v1.code, brief(loose));
  const unknown = await T.get('/vouchers/GV-ZZZZ-ZZZZ');
  check('an unknown code: usable 0 and a plain reason, not an error', unknown.status === 200 && unknown.data.data.status === 'UNKNOWN' && unknown.data.data.usablePaise === 0, brief(unknown));
  const exp = await prisma.giftVoucher.create({ data: { clientId: C, code: 'GV-EXPD-AAAA', initialPaise: 100000, balancePaise: 100000, expiresAt: new Date(Date.now() - 86_400_000) } });
  const ce = await T.get(`/vouchers/${exp.code}`);
  check('expired: EXPIRED, usable 0, says when', ce.data?.data?.status === 'EXPIRED' && ce.data.data.usablePaise === 0 && /expired on/.test(ce.data.data.reason), brief(ce));
  const zero = await prisma.giftVoucher.create({ data: { clientId: C, code: 'GV-ZERO-AAAA', initialPaise: 100000, balancePaise: 0, expiresAt: new Date(Date.now() + 86_400_000) } });
  check('used up: USED_UP, usable 0', (await T.get(`/vouchers/${zero.code}`)).data?.data?.status === 'USED_UP');
  gv.forgetMisses();
  let stopped: any = null;
  for (let i = 0; i < 25; i++) { const r = await T2.get(`/vouchers/GV-NOPE-${String(i).padStart(4, 'A').replace(/\d/g, 'B')}`); if (r.status === 429) { stopped = { i, r }; break; } }
  check('guessing codes: stopped after 20 wrong ones in a minute (429), in words', stopped?.i === 20 && ans(stopped.r) === 'TOO_MANY_TRIES', stopped ? brief(stopped.r) : 'never stopped');
  const otherTill = await T.get(`/vouchers/${v1.code}`);
  check('...only that till: another till still checks codes', otherTill.status === 200);
  gv.forgetMisses();

  console.log('\nD. THE SHOP\'S SIDE');
  const v1row = (await prisma.giftVoucher.findFirst({ where: { clientId: C, code: v1.code } }))!;
  const sum = await gv.summary(C);
  check('summary: owed counts open vouchers only (not expired, used up)', sum.owedPaise === (await prisma.giftVoucher.aggregate({ where: { clientId: C, status: 'ACTIVE', balancePaise: { gt: 0 }, expiresAt: { gte: new Date() } }, _sum: { balancePaise: true } }))._sum.balancePaise && sum.soldThisMonth >= 4, sum);
  check('search by code', (await gv.list(C, { search: v1.code })).length === 1);
  check('search by the buyer\'s phone, typed any way', (await gv.list(C, { search: '98480 77711' }))[0]?.code === v1.code);
  check('search by the buyer\'s name', (await gv.list(C, { search: 'priya' }))[0]?.code === v1.code);
  check('filter: expired shows only the expired one', JSON.stringify((await gv.list(C, { status: 'EXPIRED' })).map(v => v.code)) === JSON.stringify(['GV-EXPD-AAAA']));
  const ext = await gv.extend(C, v1row.id, 3, 'tester');
  check('extend by 3 months: new date, an EXTENDED line saying from and to', Math.round((new Date(ext.expiresAt).getTime() - v1row.expiresAt.getTime()) / 86_400_000) >= 89 && ext.entries.some(e => e.kind === 'EXTENDED' && /Valid until .* \(was /.test(e.note ?? '')), ext.entries);
  const lateExt = await gv.extend(C, exp.id, 1, 'tester').then(() => null, e => e);
  check('an expired voucher cannot be extended (the shop keeps it), said in words', lateExt?.statusCode === 400 && /expired/.test(lateExt.message), lateExt?.message);
  check('extend by 0 or 25 months: refused', (await gv.extend(C, v1row.id, 0, 't').then(() => null, e => e))?.statusCode === 400 && (await gv.extend(C, v1row.id, 25, 't').then(() => null, e => e))?.statusCode === 400);
  const noWhy = await gv.block(C, v1row.id, ' ', 'tester').then(() => null, e => e);
  check('blocking needs a reason', noWhy?.statusCode === 400);
  await gv.block(C, v1row.id, 'Lost by the customer', 'tester');
  const cb = await T.get(`/vouchers/${v1.code}`, { params: { billPaise: 1000 } });
  check('blocked: the till is told, usable 0', cb.data?.data?.status === 'BLOCKED' && cb.data.data.usablePaise === 0, brief(cb));
  check('blocking twice is refused', (await gv.block(C, v1row.id, 'again', 't').then(() => null, e => e))?.statusCode === 400);
  await gv.unblock(C, v1row.id, 'tester');
  check('unblocked: usable again', (await T.get(`/vouchers/${v1.code}`)).data?.data?.status === 'ACTIVE');
  const hist = await gv.detail(C, v1row.id);
  check('its history: sold, extended, blocked, unblocked -- in order, balance unchanged', JSON.stringify(hist.entries.map(e => e.kind)) === JSON.stringify(['SOLD', 'EXTENDED', 'BLOCKED', 'UNBLOCKED']) && hist.entries.every(e => e.balancePaise === 500000), hist.entries.map(e => e.kind));
  check('another shop cannot see or change it', (await gv.detail(`other-${STAMP}`, v1row.id).then(() => null, e => e))?.statusCode === 404 && (await gv.block(`other-${STAMP}`, v1row.id, 'x x x', 't').then(() => null, e => e))?.statusCode === 404);

  console.log('\nE. THE DAY BOOK');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const db: any = await dayBookService.getDay(C, today);
  const soldToday = await prisma.giftVoucherEntry.aggregate({ where: { clientId: C, kind: 'SOLD' }, _sum: { amountPaise: true } });
  const cashSold = (await prisma.giftVoucherEntry.findMany({ where: { clientId: C, kind: 'SOLD' } })).flatMap(e => e.payments as any[]).filter(p => p.method === 'CASH').reduce((t, p) => t + p.amountPaise, 0);
  check('a Gift vouchers section: sold today, by how paid', db.giftVouchers && db.giftVouchers.sold === (soldToday._sum.amountPaise ?? 0) / 100 && db.giftVouchers.soldBy.CASH === cashSold / 100 && db.giftVouchers.soldBy.UPI === 2000, db.giftVouchers);
  check('...not in sales', !JSON.stringify(db.sales ?? {}).includes(String((soldToday._sum.amountPaise ?? 0) / 100)) || (db.sales?.revenue ?? 0) < 1000 + 1, db.sales);
  check('cash in the drawer includes the cash taken for vouchers', db.money.cashInDrawer === cashSold / 100, { drawer: db.money.cashInDrawer, cashSold: cashSold / 100 });

  console.log('\nF. PERMISSIONS');
  const role = await prisma.role.create({ data: { clientId: C, name: `No vouchers ${STAMP}`, isSystem: false } as any }).catch(() => null);
  const user = await prisma.user.create({ data: { clientId: C, name: 'No Voucher', email: `nv-${STAMP}@example.com`, password: 'x', status: 'ACTIVE', ...(role ? { roles: { create: { roleId: role.id } } } : {}) } as any });
  const token = AuthService.generateToken({ userId: user.id, clientId: C, sessionVersion: (user as any).sessionVersion ?? 0 });
  const H = axios.create({ baseURL: API, headers: { Cookie: `token=${token}` }, validateStatus: () => true });
  const r = await Promise.all([H.get('/gift-vouchers'), H.get(`/gift-vouchers/${v1row.id}`), H.put('/gift-vouchers/settings', { enabled: false }), H.post(`/gift-vouchers/${v1row.id}/block`, { reason: 'nope nope' })]);
  check('a role without voucher permissions: list, detail, settings and block all refused (403)', r.every(x => x.status === 403), r.map(x => x.status).join(','));
  const none = await axios.get(`${API}/gift-vouchers`, { validateStatus: () => true });
  check('not signed in: 401', none.status === 401);
  const noKey = await axios.post(`${API}/pos/v1/vouchers`, {}, { validateStatus: () => true });
  check('selling without a till key: 401', noKey.status === 401);
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  const w = { clientId: C };
  const steps: [string, () => Promise<unknown>][] = [
    ['entries', () => prisma.giftVoucherEntry.deleteMany({ where: w })],
    ['vouchers', () => prisma.giftVoucher.deleteMany({ where: w })],
    ['settings', () => prisma.giftVoucherSettings.deleteMany({ where: w })],
    ['payments', () => prisma.salesOrderPayment.deleteMany({ where: w })],
    ['orders', () => prisma.salesOrder.deleteMany({ where: w })],
    ['user roles', () => prisma.userRole.deleteMany({ where: { user: { clientId: C } } } as any)],
    ['users', () => prisma.user.deleteMany({ where: w })],
    ['roles', () => prisma.role.deleteMany({ where: w })],
    ['customers', () => prisma.customer.deleteMany({ where: w })],
    ['connections', () => prisma.storefrontConnection.deleteMany({ where: w })],
    ['shop settings', () => prisma.clientSettings.deleteMany({ where: w })],
    ['locations', () => prisma.stockLocation.deleteMany({ where: w })]
  ];
  const left: string[] = [];
  for (const [label, run] of steps) { try { await run(); } catch (e: any) { left.push(`${label}: ${String(e.message).split('\n').slice(-1)[0]}`); } }
  console.log(left.length ? `\nteardown left behind -- ${left.join('; ')}` : '\nthrowaway shop removed');
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
