/**
 * LOYALTY POINTS and WHATSAPP CAMPAIGNS, worst cases included.
 *
 *   R  the arithmetic (pure): earning, the per-bill limit, steps, cumulative return shares, days
 *   A  the shop's rules: who may set them, and nonsense refused in words
 *   B  earning at the counter; a retried sale earns once
 *   C  paying with points: every refusal, then a good one; points bought with points earn nothing
 *   D  two tills spending the same points at the same moment: one wins
 *   E  returns: points used come back as points and the money owed drops; points earned go back;
 *      three partial returns undo exactly what one would; a rejected return changes nothing
 *   F  changing points by hand: reason, once per press, never below zero, owner only
 *   G  agreeing to offers, and STOP: the counter tick, the customer page, the WhatsApp STOP event
 *   H  campaigns: words, who they reach, start, fixed list, pause, stop, the slow sender (hours,
 *      not linked, daily budget, three in flight, STOP after start, refusals, WhatsApp down, once
 *      per customer), finishing
 *   I  the daily job: birthday gift and wish once a year, anniversary, lapsing, the lapse reminder
 *   J  another shop sees none of it
 *
 * WhatsApp is never really called: the client is swapped for a recorder before anything sends.
 *
 *   npx tsx src/scripts/verify-loyalty-campaigns.ts     (needs the local backend running)
 */
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { returnService } from '../services/return.service';
import { whatsappClient, WhatsAppServiceError } from '../services/whatsapp/client';
import * as wa from '../services/whatsapp/service';
import * as R from '../services/loyalty/rules';
import { runCampaignTick, prepareShopDay, sendAfterSaleNotice, campaigns, render } from '../services/campaigns';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `loyal-${STAMP}`;
const OTHER = `loyal-other-${STAMP}`;

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
const api = (token: string): AxiosInstance => axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true, timeout: 120_000 });
const throws = async (fn: () => unknown) => { try { await fn(); return null; } catch (e: any) { return e; } };

// ── The WhatsApp recorder ────────────────────────────────────────────────────────────────
const sent: any[] = [];
let account: { status: string; phone: string | null; linkedAt: string | null; lastSeenAt: null } = { status: 'CONNECTED', phone: '919000000001', linkedAt: new Date(Date.now() - 30 * 86400000).toISOString(), lastSeenAt: null };
let refuse: ((input: any) => Error | null) | null = null;
const realSend = whatsappClient.send, realAccount = whatsappClient.account;
(whatsappClient as any).send = async (input: any) => {
  const r = refuse?.(input);
  if (r) throw r;
  const seen = sent.find(s => s.idempotencyKey === input.idempotencyKey);
  if (seen) return { id: seen.id, status: 'QUEUED', duplicate: true };
  const id = crypto.randomUUID();
  sent.push({ ...input, id });
  return { id, status: 'QUEUED' };
};
(whatsappClient as any).account = async () => ({ ...account });

let phoneN = 0;
const phone = () => `+91 9${String(STAMP).slice(-5)}${String(++phoneN).padStart(4, '0')}`;

async function person(clientId: string, name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId, email: `loyal-${name.toLowerCase()}-${clientId}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, name, http: api(AuthService.generateToken({ userId: u.id, clientId })) };
}

async function main() {
  // ── R ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nR. THE ARITHMETIC');
  const rules = { ...R.DEFAULT_RULES };
  check('1 point per full ₹100: ₹2,599.99 earns 25', R.pointsEarned(259999, rules) === 25);
  check('  ...₹99 earns nothing, nothing earns nothing', R.pointsEarned(9900, rules) === 0 && R.pointsEarned(0, rules) === 0);
  check('  ...a shop giving 0 per ₹100 gives nothing', R.pointsEarned(1_000_000, { pointsPer100: 0 }) === 0);
  check('usable: holds 300, bill ₹400, 50% cap -> 200', R.mostUsable(300, 40000, rules) === 200);
  check('  ...holds 99 with 100 needed -> none', R.mostUsable(99, 40000, rules) === 0);
  check('  ...a point worth ₹3 on a ₹100 bill at 50% -> 16 points (₹48)', R.mostUsable(500, 10000, { ...rules, pointValuePaise: 300 }) === 16);
  const e1 = await throws(() => R.pointsForPayment(15050, 100000, 500, rules));
  check('a points amount that is not whole points is refused in words', e1?.statusCode === 400 && plain(e1.message), e1?.message);
  const e2 = await throws(() => R.pointsForPayment(10000, 100000, 50, rules));
  check('below the minimum is refused, saying the minimum and the balance', e2?.statusCode === 400 && /100/.test(e2.message) && /50/.test(e2.message), e2?.message);
  const e3 = await throws(() => R.pointsForPayment(60000, 100000, 1000, rules));
  check('over half the bill is refused, saying the most allowed', e3?.statusCode === 400 && /500 points/.test(e3.message), e3?.message);
  const e4 = await throws(() => R.pointsForPayment(30000, 100000, 200, rules));
  check('more than held is refused', e4?.statusCode === 400 && /200 points/.test(e4.message), e4?.message);
  check('  ...and a good one gives the points', R.pointsForPayment(20000, 100000, 300, rules) === 200);
  const parts = [R.shareBetween(7, 1000, 0, 333), R.shareBetween(7, 1000, 333, 666), R.shareBetween(7, 1000, 666, 1000)];
  check('three partial returns of 7 points add up to exactly 7', parts.reduce((a, b) => a + b, 0) === 7, parts);
  check('  ...a share past the bill is capped', R.shareBetween(10, 1000, 900, 5000) === 1);
  check('days: 2026-03-05 -> 03-05, 3-5 -> 03-05', R.monthDay('2026-03-05') === '03-05' && R.monthDay('3-5') === '03-05');
  check('  ...31 Feb refused, 29 Feb allowed', (await throws(() => R.monthDay('02-31')))?.statusCode === 400 && R.monthDay('02-29') === '02-29');
  check('a 29 Feb birthday is wished on 28 Feb in a common year, not in a leap year',
    R.birthdayKeysFor('2027-02-28').includes('02-29') && !R.birthdayKeysFor('2028-02-28').includes('02-29'));
  const msg = render('Hi {name}, {points} points ({points_value}) at {shop}', { name: 'Lakshmi Devi Rao', shop: 'Sree Silks', points: 1250, pointsValue: '₹1,250' });
  check('the message uses the first name, fills everything in, and always ends with STOP', /^Hi Lakshmi, 1,250 points \(₹1,250\) at Sree Silks/.test(msg) && /Reply STOP/.test(msg), msg);

  // ── setup ────────────────────────────────────────────────────────────────────────────────
  console.log(`\nSETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const otherRoles = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Sree Silks' } });
  await prisma.clientSettings.create({ data: { clientId: OTHER, businessName: 'Other Shop' } });
  const owner = await person(SHOP, 'Owner', roles.SUPER_ADMIN);
  const sales = await person(SHOP, 'Sita', roles.SALES);
  const stranger = await person(OTHER, 'Stranger', otherRoles.SUPER_ADMIN);
  const own = owner.http;

  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true } });
  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Silk Saree', productCode: `LY-${STAMP}`, slug: `ly-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } });
  const saree = await prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, sku: `LY-RED-${STAMP}`, variantCode: `V-LY-${STAMP}`, colorName: 'Red', size: 'Free', sellingPrice: 1000, costPrice: 600, averageCost: 600 } });
  await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: saree.id, locationId: store.id, quantity: 500 } });

  const quote = async (http: AxiosInstance, qty: number) => {
    const r = await http.post('/pricing/quote', { locationId: store.id, channel: 'POS', lines: [{ variantId: saree.id, quantity: qty }] });
    if (r.status !== 200) throw new Error(`quote failed: ${brief(r)}`);
    return r.data.data.quoteId as string;
  };
  const sell = async (http: AxiosInstance, qty: number, customer: any, payments: any[], saleId: string = crypto.randomUUID()) =>
    http.post('/counter-sales', { saleId, locationId: store.id, quoteId: await quote(http, qty), customer, items: [{ variantId: saree.id, quantity: qty }], payments });
  const pointsOf = async (customerId: string) => (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints;
  const sumOf = async (customerId: string) => (await prisma.loyaltyEntry.aggregate({ where: { customerId }, _sum: { points: true } }))._sum.points ?? 0;

  try {
    // ── A ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nA. THE SHOP\'S RULES');
    const def = await sales.http.get('/loyalty/settings');
    check('before anything: points are off, with sensible defaults (1 per ₹100, ₹1 each, 100 to start, 50% of a bill)',
      def.status === 200 && def.data.data.enabled === false && def.data.data.pointsPer100 === 1 && def.data.data.pointValuePaise === 100 && def.data.data.minRedeemPoints === 100 && def.data.data.maxRedeemPercent === 50, brief(def));
    const salesSave = await sales.http.put('/loyalty/settings', { enabled: true });
    check('a salesperson cannot switch points on', salesSave.status === 403 && plain(salesSave.data.message), brief(salesSave));
    for (const [body, what] of [[{ maxRedeemPercent: 0 }, '0% of a bill'], [{ pointsPer100: 1.5 }, 'half points'], [{ pointValuePaise: -1 }, 'a negative value'], [{ enabled: 'yes' }, '"yes" as text'], [{ birthdayText: 'x'.repeat(701) }, 'a 701-letter wish']] as const) {
      const r = await own.put('/loyalty/settings', body);
      check(`refused in words: ${what}`, r.status === 400 && plain(r.data.message), brief(r));
    }
    const on = await own.put('/loyalty/settings', { enabled: true, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 100, maxRedeemPercent: 50, expiryMonths: 12 });
    check('the owner switches points on', on.status === 200 && on.data.data.enabled === true, brief(on));

    // ── B ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nB. EARNING AT THE COUNTER');
    const lakshmiPhone = phone();
    const saleId = crypto.randomUUID();
    const s1 = await sell(sales.http, 3, { phone: lakshmiPhone, name: 'Lakshmi Devi', offersOk: true }, [{ method: 'CASH', amount: 3000 }], saleId);
    check('a ₹3,000 sale goes through', s1.status === 201 || s1.status === 200, brief(s1));
    const lakshmi = await prisma.customer.findFirstOrThrow({ where: { clientId: SHOP, name: 'Lakshmi Devi' } });
    check('  ...and earns 30 points', await pointsOf(lakshmi.id) === 30 && await sumOf(lakshmi.id) === 30);
    const again = await sell(sales.http, 3, { phone: lakshmiPhone, name: 'Lakshmi Devi' }, [{ method: 'CASH', amount: 3000 }], saleId);
    check('the same sale pressed again is the same sale, and earns nothing more', (again.status === 200 || again.status === 201) && await pointsOf(lakshmi.id) === 30, brief(again));
    const counterView = await sales.http.get('/loyalty/counter', { params: { customerId: lakshmi.id, bill: 1000 } });
    check('the counter sees 30 points, and none usable yet (100 needed)', counterView.data.data.points === 30 && counterView.data.data.usablePoints === 0, brief(counterView));
    await sell(sales.http, 17, { id: lakshmi.id }, [{ method: 'UPI', amount: 17000, reference: 'UTR1' }]);
    check('a ₹17,000 sale takes her to 200', await pointsOf(lakshmi.id) === 200);

    // ── C ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nC. PAYING WITH POINTS');
    await own.put('/loyalty/settings', { maxRedeemPercent: 10 });
    const over = await sell(sales.http, 1, { id: lakshmi.id }, [{ method: 'POINTS', amount: 150 }, { method: 'CASH', amount: 850 }]);
    check('with points allowed on 10% of a bill, 150 points on ₹1,000 is refused, saying the most (100)', over.status === 400 && /10%/.test(over.data.message) && /100 points/.test(over.data.message), brief(over));
    await own.put('/loyalty/settings', { maxRedeemPercent: 50 });
    const tooMany = await sell(sales.http, 1, { id: lakshmi.id }, [{ method: 'POINTS', amount: 300 }, { method: 'CASH', amount: 700 }]);
    check('300 points when she holds 200 is refused, saying what she holds', tooMany.status === 400 && /200 points/.test(tooMany.data.message), brief(tooMany));
    const step = await sell(sales.http, 1, { id: lakshmi.id }, [{ method: 'POINTS', amount: 150.5 }, { method: 'CASH', amount: 849.5 }]);
    check('₹150.50 of points (not whole points) is refused', step.status === 400 && plain(step.data.message), brief(step));
    const two = await sell(sales.http, 1, { id: lakshmi.id }, [{ method: 'POINTS', amount: 100 }, { method: 'POINTS', amount: 100 }, { method: 'CASH', amount: 800 }]);
    check('points twice on one bill is refused', two.status === 400 && /once/.test(two.data.message), brief(two));
    const change = await sell(sales.http, 1, { id: lakshmi.id }, [{ method: 'POINTS', amount: 100, cashReceived: 200 }, { method: 'CASH', amount: 900 }]);
    check('change on points is refused', change.status === 400, brief(change));
    check('  ...none of those took a single point', await pointsOf(lakshmi.id) === 200);
    const good = await sell(sales.http, 3, { id: lakshmi.id }, [{ method: 'POINTS', amount: 150 }, { method: 'CASH', amount: 2850 }]);
    check('150 points on a ₹3,000 bill go through', good.status === 201 || good.status === 200, brief(good));
    check('  ...200 - 150 used + 28 earned on the ₹2,850 paid in money = 78', await pointsOf(lakshmi.id) === 78 && await sumOf(lakshmi.id) === 78, String(await pointsOf(lakshmi.id)));
    const goodOrder = good.data.data;
    check('  ...the receipt shows a Points payment of ₹150', goodOrder.payments.some((p: any) => p.method === 'POINTS' && p.amount === 150), JSON.stringify(goodOrder.payments));
    check('  ...and the bill is fully paid', goodOrder.payment.status === 'PAID', JSON.stringify(goodOrder.payment));
    const newGuy = await sell(sales.http, 1, { phone: phone(), name: 'Nobody Yet' }, [{ method: 'POINTS', amount: 100 }, { method: 'CASH', amount: 900 }]);
    check('a new customer with no points cannot pay with points, and no customer is left behind', newGuy.status === 400 && (await prisma.customer.count({ where: { clientId: SHOP, name: 'Nobody Yet' } })) === 0, brief(newGuy));

    // ── D ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nD. TWO TILLS, THE SAME POINTS');
    const ravi = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `RAVI-${STAMP}`, name: 'Ravi Kumar', phone: `+919${String(STAMP).slice(-5)}8888` } });
    await prisma.$transaction(tx => import('../services/loyalty').then(l => l.post(tx, { clientId: SHOP, customerId: ravi.id, kind: 'ADJUSTED', points: 150, onceKey: `SEED:${ravi.id}` })));
    const [q1, q2] = [await quote(sales.http, 1), await quote(own, 1)];
    const race = await Promise.all([
      sales.http.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: store.id, quoteId: q1, customer: { id: ravi.id }, items: [{ variantId: saree.id, quantity: 1 }], payments: [{ method: 'POINTS', amount: 100 }, { method: 'CASH', amount: 900 }] }),
      own.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: store.id, quoteId: q2, customer: { id: ravi.id }, items: [{ variantId: saree.id, quantity: 1 }], payments: [{ method: 'POINTS', amount: 100 }, { method: 'CASH', amount: 900 }] })
    ]);
    const won = race.filter(r => r.status === 200 || r.status === 201).length;
    check('two tills spending 100 of Ravi\'s 150 points at once: exactly one sale goes through', won === 1, race.map(brief).join(' | '));
    check('  ...the other is told plainly', race.some(r => r.status === 400 && plain(r.data.message)), race.map(brief).join(' | '));
    check('  ...and he is left with 150 - 100 + 9 = 59, never below zero', await pointsOf(ravi.id) === 59 && await sumOf(ravi.id) === 59, String(await pointsOf(ravi.id)));

    // ── E ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nE. RETURNS');
    const orderId = goodOrder.id;
    const items = await prisma.dispatchItem.findMany({ where: { dispatch: { salesOrderId: orderId } } });
    const before = await pointsOf(lakshmi.id);
    const r1: any = await returnService.createReturn(SHOP, orderId, [{ dispatchItemId: items[0].id, quantity: 1 }], 'size', 'SIZE_ISSUE' as any);
    check('returning 1 of 3 sarees: ₹1,000 owed back before completing', Number(r1.refundTotal) === 1000, String(r1.refundTotal));
    const r1open: any = await returnService.getReturnById(SHOP, r1.id);
    check('  ...and the open return already says ₹50 goes back as points, so ₹950 is the money to pay', r1open.pointsPreview?.pointsBack === 50 && r1open.pointsPreview?.money === 950 && r1open.pointsPreview?.pointsTakenBack === 9, JSON.stringify(r1open.pointsPreview));
    await returnService.inspectReturn(SHOP, r1.id, [{ salesReturnItemId: r1.items[0].id, disposition: 'RESTOCK' }]);
    await returnService.completeReturn(SHOP, r1.id);
    const r1d = await prisma.salesReturn.findUniqueOrThrow({ where: { id: r1.id } });
    check('  ...on completing, 50 of the 150 points used come back as points', r1d.pointsBack === 50 && Number(r1d.pointsBackValue) === 50, JSON.stringify(r1d));
    check('  ...so the money owed is ₹950, not ₹1,000', Number(r1d.refundTotal) === 950, String(r1d.refundTotal));
    check('  ...and 9 of the 28 earned are taken back', r1d.pointsTakenBack === 9, String(r1d.pointsTakenBack));
    check('  ...her balance: 78 + 50 - 9 = 119', await pointsOf(lakshmi.id) === before + 50 - 9 && await sumOf(lakshmi.id) === await pointsOf(lakshmi.id), String(await pointsOf(lakshmi.id)));
    const again1 = await throws(() => returnService.completeReturn(SHOP, r1.id));
    check('completing the same return again is refused and changes no points', !!again1 && await pointsOf(lakshmi.id) === before + 41);
    const r2: any = await returnService.createReturn(SHOP, orderId, [{ dispatchItemId: items[0].id, quantity: 1 }], 'size', 'SIZE_ISSUE' as any);
    await returnService.rejectReturn(SHOP, r2.id);
    check('a rejected return changes no points', await pointsOf(lakshmi.id) === before + 41);
    const r3: any = await returnService.createReturn(SHOP, orderId, [{ dispatchItemId: items[0].id, quantity: 2 }], 'size', 'SIZE_ISSUE' as any);
    await returnService.inspectReturn(SHOP, r3.id, [{ salesReturnItemId: r3.items[0].id, disposition: 'RESTOCK' }]);
    await returnService.completeReturn(SHOP, r3.id);
    const r3d = await prisma.salesReturn.findUniqueOrThrow({ where: { id: r3.id } });
    check('returning the other 2: exactly the rest of the points come back (100) and are taken (19)', r3d.pointsBack === 100 && r3d.pointsTakenBack === 19, JSON.stringify(r3d));
    check('  ...money owed across both returns is ₹2,850, exactly what was paid in money', Number(r1d.refundTotal) + Number(r3d.refundTotal) === 2850, `${r1d.refundTotal} + ${r3d.refundTotal}`);
    check('  ...and the whole bill is undone: back to the 200 she had before it', await pointsOf(lakshmi.id) === 200, String(await pointsOf(lakshmi.id)));
    const plainSale = await sell(sales.http, 1, { phone: phone(), name: 'Cash Only' }, [{ method: 'CASH', amount: 1000 }]);
    const cashOnly = await prisma.customer.findFirstOrThrow({ where: { clientId: SHOP, name: 'Cash Only' } });
    const pItems = await prisma.dispatchItem.findMany({ where: { dispatch: { salesOrderId: plainSale.data.data.id } } });
    const r4: any = await returnService.createReturn(SHOP, plainSale.data.data.id, [{ dispatchItemId: pItems[0].id, quantity: 1 }], 'x', 'OTHER' as any);
    await returnService.inspectReturn(SHOP, r4.id, [{ salesReturnItemId: r4.items[0].id, disposition: 'RESTOCK' }]);
    await returnService.completeReturn(SHOP, r4.id);
    const r4d = await prisma.salesReturn.findUniqueOrThrow({ where: { id: r4.id } });
    check('a cash-only bill returned: all ₹1,000 is money, 10 earned points taken back', Number(r4d.refundTotal) === 1000 && r4d.pointsTakenBack === 10 && await pointsOf(cashOnly.id) === 0, JSON.stringify(r4d));

    // ── F ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nF. CHANGING POINTS BY HAND');
    const nonce = crypto.randomUUID();
    const noReason = await own.post(`/loyalty/customers/${lakshmi.id}/adjust`, { points: 50, reason: '', nonce });
    check('no reason, no change', noReason.status === 400 && plain(noReason.data.message), brief(noReason));
    const salesAdj = await sales.http.post(`/loyalty/customers/${lakshmi.id}/adjust`, { points: 50, reason: 'gift', nonce });
    check('a salesperson cannot change points', salesAdj.status === 403, brief(salesAdj));
    const adj = await own.post(`/loyalty/customers/${lakshmi.id}/adjust`, { points: 50, reason: 'Diwali gift', nonce });
    const adj2 = await own.post(`/loyalty/customers/${lakshmi.id}/adjust`, { points: 50, reason: 'Diwali gift', nonce });
    check('the owner adds 50; the same press twice adds them once', adj.status === 200 && adj2.status === 200 && await pointsOf(lakshmi.id) === 250, `${brief(adj)} | ${await pointsOf(lakshmi.id)}`);
    const below = await own.post(`/loyalty/customers/${lakshmi.id}/adjust`, { points: -1000, reason: 'mistake', nonce: crypto.randomUUID() });
    check('taking more than she has is refused', below.status === 400 && /below zero/.test(below.data.message) && await pointsOf(lakshmi.id) === 250, brief(below));
    const hist = await sales.http.get(`/loyalty/customers/${lakshmi.id}`);
    check('her history reads in words, newest first, with order numbers', hist.status === 200 && hist.data.data.entries[0].label === 'Changed by hand' && hist.data.data.entries.some((e: any) => e.orderNumber) && hist.data.data.points === 250, brief(hist));
    check('  ...and says when the points lapse (a year after her last purchase)', !!hist.data.data.lapsesOn, brief(hist));

    // ── G ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nG. AGREEING TO OFFERS, AND STOP');
    check('the counter tick recorded Lakshmi\'s yes, with who and when', lakshmi.whatsappOffers === true && lakshmi.whatsappOffersBy === sales.id && !!lakshmi.whatsappOffersAt);
    const cashOnlyC = await prisma.customer.findUniqueOrThrow({ where: { id: cashOnly.id } });
    check('a customer sold to without the tick has not agreed', cashOnlyC.whatsappOffers === false);
    const put = await sales.http.put(`/campaigns/consent/${cashOnly.id}`, { agreed: true });
    check('the customer page records a yes', put.status === 200 && put.data.data.agreed === true && put.data.data.changedBy === 'Sita', brief(put));
    const bday = await sales.http.patch(`/customers/${cashOnly.id}`, { birthday: '2026-03-15', anniversary: '02-31' });
    check('an impossible anniversary is refused in words', bday.status === 400 && plain(bday.data.message), brief(bday));
    const bday2 = await sales.http.patch(`/customers/${cashOnly.id}`, { birthday: '1990-03-15' });
    check('a birthday from a date picker keeps month and day only', bday2.status === 200 && (await prisma.customer.findUniqueOrThrow({ where: { id: cashOnly.id } })).birthday === '03-15', brief(bday2));
    const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
    const digits = ravi.phone!.replace(/\D/g, '');
    await prisma.customer.update({ where: { id: ravi.id }, data: { whatsappOffers: true, whatsappOffersAt: new Date() } });
    const stopped = await wa.handleEvent({ id: `evt-${STAMP}-stop`, type: 'contact.opted_out', data: { kind: 'CLIENT', clientId: SHOP, contact: digits } });
    const raviNow = await prisma.customer.findUniqueOrThrow({ where: { id: ravi.id } });
    check('a STOP from WhatsApp stops Ravi and takes back his yes', stopped.handled === true && !!raviNow.whatsappStoppedAt && raviNow.whatsappOffers === false, JSON.stringify(stopped));
    const stopOther = await wa.handleEvent({ id: `evt-${STAMP}-stop2`, type: 'contact.opted_out', data: { kind: 'CLIENT', clientId: OTHER, contact: digits } });
    check('  ...the same number replying STOP to another shop does not stop him here', stopOther.handled === true && (await prisma.customer.findUniqueOrThrow({ where: { id: ravi.id } })).whatsappStoppedAt?.getTime() === raviNow.whatsappStoppedAt?.getTime());
    const reAgree = await own.put(`/campaigns/consent/${ravi.id}`, { agreed: true });
    check('  ...and nobody at the shop can turn him back on', reAgree.status === 400 && /STOP/.test(reAgree.data.message), brief(reAgree));
    const bulkNo = await own.post('/campaigns/consent/bulk', { customerIds: [ravi.id] });
    check('marking many as agreed needs the person to confirm', bulkNo.status === 400, brief(bulkNo));
    const bulk = await own.post('/campaigns/consent/bulk', { customerIds: [ravi.id, cashOnly.id], confirmed: true });
    check('  ...confirmed, it skips Ravi (STOP) and the one already agreed', bulk.status === 200 && bulk.data.data.marked === 0 && bulk.data.data.skipped === 2, brief(bulk));
    void secret;

    // Give the campaigns a few more customers who agreed.
    const crowd: string[] = [];
    for (let i = 0; i < 26; i++) {
      const c = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `C-${STAMP}-${i}`, name: `Crowd ${i} Surname`, phone: `+919${String(STAMP).slice(-4)}${String(i).padStart(5, '0')}`, whatsappOffers: true, whatsappOffersAt: new Date(), tags: i < 3 ? ['vip'] : [] } });
      crowd.push(c.id);
    }

    // ── H ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nH. CAMPAIGNS');
    const bad1 = await own.post('/campaigns', { name: 'Diwali', text: 'Hi {firstname}' });
    check('a placeholder ScaleEzy cannot fill is refused, naming it', bad1.status === 400 && /\{firstname\}/.test(bad1.data.message), brief(bad1));
    const bad2 = await own.post('/campaigns', { name: '', text: 'x' });
    check('no name is refused', bad2.status === 400 && plain(bad2.data.message), brief(bad2));
    const bad3 = await own.post('/campaigns', { name: 'X', text: 'x'.repeat(1001) });
    check('a 1,001-letter message is refused', bad3.status === 400, brief(bad3));
    const bad4 = await own.post('/campaigns', { name: 'X', text: 'x', audience: { boughtWithinDays: 60, notBoughtForDays: 30 } });
    check('choices that can match nobody are refused', bad4.status === 400 && plain(bad4.data.message), brief(bad4));
    const salesMake = await sales.http.post('/campaigns', { name: 'X', text: 'x' });
    check('a salesperson cannot write a campaign', salesMake.status === 403, brief(salesMake));

    const vip = await own.post('/campaigns/preview', { audience: { tags: ['VIP'] } });
    check('the VIP group, spelt differently from how it was saved, finds the 3 VIPs', vip.status === 200 && vip.data.data.count === 3, brief(vip));
    const all = await own.post('/campaigns/preview', { audience: {} });
    check('everyone who agreed: Lakshmi, Cash Only and the 26 (not Ravi, who said STOP)', all.data.data.count === 28, brief(all));
    const recent = await own.post('/campaigns/preview', { audience: { boughtWithinDays: 7 } });
    check('bought in the last 7 days: Lakshmi and Cash Only', recent.data.data.count === 2, brief(recent));
    const quiet = await own.post('/campaigns/preview', { audience: { notBoughtForDays: 30 } });
    check('nothing bought for 30 days: nobody (the 26 never bought)', quiet.data.data.count === 0, brief(quiet));
    const spend = await own.post('/campaigns/preview', { audience: { minSpend: 10000 } });
    check('spent at least ₹10,000: Lakshmi only', spend.data.data.count === 1 && spend.data.data.sample[0].name === 'Lakshmi Devi', brief(spend));
    const rich = await own.post('/campaigns/preview', { audience: { minPoints: 200 } });
    check('hold 200+ points: Lakshmi only', rich.data.data.count === 1, brief(rich));

    const made = await own.post('/campaigns', { name: 'Diwali sale', text: 'Hello {name}! Diwali sale at {shop}: 20% off silk. You have {points} points.', audience: {} });
    check('a draft campaign is written', made.status === 201 && made.data.data.status === 'DRAFT', brief(made));
    const cid = made.data.data.id;
    const changed = await own.post(`/campaigns/${cid}/start`, { expected: 5 });
    check('Start with a count far from what it now reaches asks the person to look again', changed.status === 409 && changed.data.details?.code === 'AUDIENCE_CHANGED' || /28 customers/.test(changed.data.message), brief(changed));
    const started = await own.post(`/campaigns/${cid}/start`, { expected: 28 });
    check('Start: 28 customers, sending', started.status === 200 && started.data.data.status === 'SENDING' && started.data.data.progress.total === 28, brief(started));
    const twice = await own.post(`/campaigns/${cid}/start`, {});
    check('Start pressed twice is refused, and the list is not doubled', twice.status === 409 && (await prisma.campaignRecipient.count({ where: { campaignId: cid } })) === 28, brief(twice));
    const edit = await own.patch(`/campaigns/${cid}`, { text: 'changed' });
    check('the words cannot change after Start', edit.status === 409 && plain(edit.data.message), brief(edit));
    const del = await own.delete(`/campaigns/${cid}`);
    check('a started campaign cannot be deleted', del.status === 409, brief(del));

    // After Start, one of the 26 says STOP: skipped when their turn comes.
    await prisma.customer.update({ where: { id: crowd[0] }, data: { whatsappStoppedAt: new Date(), whatsappOffers: false } });

    // h:00 today in India, whatever the time is here.
    const at = (h: number) => { const ist = new Date(Date.now() + 5.5 * 3600000); return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h) - 5.5 * 3600000); };
    const night = await runCampaignTick(at(22), { onlyClients: [SHOP] });
    check('at 10 pm nothing is sent', sent.length === 0 && night[0]?.waitingBecause === 'hours', JSON.stringify(night));
    account = { ...account, status: 'DISCONNECTED' };
    const dropped = await runCampaignTick(at(11), { onlyClients: [SHOP] });
    check('the shop\'s WhatsApp not connected: nothing is sent, nothing is lost', sent.length === 0 && dropped[0]?.waitingBecause === 'not_connected' && (await prisma.campaignRecipient.count({ where: { campaignId: cid, state: 'WAITING' } })) === 28, JSON.stringify(dropped));
    account = { ...account, status: 'CONNECTED', linkedAt: new Date(Date.now() - 3 * 86400000).toISOString() };

    const t1 = await runCampaignTick(at(11), { onlyClients: [SHOP] });
    check('at 11 am: three handed over (never more than 3 waiting at WhatsApp)', t1[0].handed === 3 && sent.length === 3, JSON.stringify(t1));
    check('  ...each personal, with its own name and the STOP line', sent.every(s => /Hello \w+! Diwali sale at Sree Silks/.test(s.text) && /Reply STOP/.test(s.text) && s.kind === 'C8'), sent.map(s => s.text.slice(0, 40)));
    check('  ...each keyed to the campaign and the customer', new Set(sent.map(s => s.idempotencyKey)).size === 3 && sent.every(s => s.idempotencyKey.startsWith(`CAMPAIGN:${cid}:`)));
    const t2 = await runCampaignTick(at(11), { onlyClients: [SHOP] });
    check('the next pass hands nothing while those 3 still wait at WhatsApp', t2[0].handed === 0 && t2[0].waitingBecause === 'in_flight', JSON.stringify(t2));

    // WhatsApp sends them: the ticks arrive.
    const ticks = async (status: string) => {
      for (const s of sent) {
        await wa.handleEvent({ id: `evt-${s.id}-${status}`, type: 'message.status', data: { messageId: s.id, status } });
      }
    };
    await ticks('DELIVERED');
    // Refusals: one number is not on WhatsApp; then WhatsApp itself goes down.
    let refusals = 0;
    refuse = (input) => (refusals++ === 0 ? new WhatsAppServiceError(400, 'This number is not on WhatsApp.') : null);
    let handedTotal = 3, failedTotal = 0;
    for (let i = 0; i < 12; i++) {
      const r = await runCampaignTick(at(12), { onlyClients: [SHOP] });
      handedTotal += r[0]?.handed ?? 0; failedTotal += r[0]?.failed ?? 0;
      await ticks('DELIVERED');
    }
    refuse = null;
    check('a new link (3 days old) sends at most 20 campaign messages a day', handedTotal === 20, `${handedTotal}`);
    check('  ...the number not on WhatsApp is marked failed with WhatsApp\'s words', failedTotal === 1 && (await prisma.campaignRecipient.findFirst({ where: { campaignId: cid, state: 'FAILED' } }))?.skipReason === 'This number is not on WhatsApp.', `${failedTotal}`);
    const budget = await runCampaignTick(at(13), { onlyClients: [SHOP] });
    check('  ...and then waits for tomorrow', budget[0].handed === 0 && budget[0].waitingBecause === 'daily_budget', JSON.stringify(budget));

    // Tomorrow (the day's count is the shop's day, so pretend the earlier ones were yesterday).
    await prisma.campaignRecipient.updateMany({ where: { campaignId: cid, handedAt: { not: null } }, data: { handedAt: new Date(Date.now() - 2 * 86400000) } });
    refuse = () => new WhatsAppServiceError(503, 'WhatsApp could not be reached just now.');
    const down = await runCampaignTick(at(11), { onlyClients: [SHOP] });
    refuse = null;
    check('WhatsApp down: nothing handed, the customer goes back in the queue', down[0].handed === 0 && down[0].waitingBecause === 'unreachable' && (await prisma.campaignRecipient.count({ where: { campaignId: cid, state: 'HANDING' } })) === 0, JSON.stringify(down));

    refuse = () => new WhatsAppServiceError(400, 'The request is not valid: kind: Invalid enum value.');
    const oldService = await runCampaignTick(at(11), { onlyClients: [SHOP] });
    refuse = null;
    check('a WhatsApp Service not yet updated for campaigns refuses the kind: the customer waits, never marked failed',
      oldService[0].handed === 0 && oldService[0].failed === 0 && (await prisma.campaignRecipient.count({ where: { campaignId: cid, state: 'FAILED' } })) === 1, JSON.stringify(oldService));

    const paused = await own.post(`/campaigns/${cid}/pause`);
    const whilePaused = await runCampaignTick(at(11), { onlyClients: [SHOP] });
    check('paused: nothing more goes', paused.data.data.status === 'PAUSED' && whilePaused.length === 0, brief(paused));
    const resumed = await own.post(`/campaigns/${cid}/resume`);
    check('carry on', resumed.data.data.status === 'SENDING', brief(resumed));
    // A crash mid-hand: a claim left behind is picked up again, and its key stops a second message.
    const oneLeft = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: cid, state: 'WAITING' } });
    await prisma.campaignRecipient.update({ where: { id: oneLeft.id }, data: { state: 'HANDING', handedAt: new Date(at(11).getTime() - 60 * 60 * 1000) } });
    const beforeCrash = sent.length;
    for (let i = 0; i < 4; i++) { await runCampaignTick(at(11), { onlyClients: [SHOP] }); await ticks('READ'); }
    const doneC = await own.get(`/campaigns/${cid}`);
    check('the rest go the next day, and the campaign finishes by itself', doneC.data.data.status === 'DONE', brief(doneC));
    check('  ...a claim left by a crash was sent once, not lost', sent.filter(s => s.idempotencyKey.endsWith(oneLeft.customerId)).length === 1 && sent.length > beforeCrash);
    const p = doneC.data.data.progress;
    check('  ...the customer who said STOP after Start was skipped, never sent', !sent.some(s => s.idempotencyKey === `CAMPAIGN:${cid}:${crowd[0]}`) && (await prisma.campaignRecipient.findFirst({ where: { campaignId: cid, customerId: crowd[0] } }))?.state === 'SKIPPED');
    check('  ...the numbers add up: 26 sent, 1 skipped, 1 failed, 28 in all', p.total === 28 && p.sent === 26 && p.skipped === 1 && p.failed === 1 && p.waiting === 0, JSON.stringify(p));
    check('  ...nobody got it twice', new Set(sent.filter(s => s.kind === 'C8').map(s => s.to)).size === sent.filter(s => s.kind === 'C8').length);
    check('  ...the list shows names, last four digits and reasons', doneC.data.data.recipients.length === 28 && doneC.data.data.recipients.every((r: any) => !r.phone || /^••••\d{4}$/.test(r.phone)) && doneC.data.data.recipients.some((r: any) => r.reason === 'The customer replied STOP.'), brief(doneC));

    const draft = await own.post('/campaigns', { name: 'Stop me', text: 'hello {name}', audience: { tags: ['vip'] } });
    await own.post(`/campaigns/${draft.data.data.id}/start`, {});
    const cancelled = await own.post(`/campaigns/${draft.data.data.id}/cancel`);
    check('a campaign stopped before its turn sends nothing, and says why', cancelled.data.data.status === 'CANCELLED' && cancelled.data.data.recipients.every((r: any) => r.reason === 'The campaign was stopped.'), brief(cancelled));
    const copy = await own.post(`/campaigns/${draft.data.data.id}/copy`);
    check('a copy is a fresh draft with the same words', copy.status === 201 && copy.data.data.status === 'DRAFT' && copy.data.data.text === 'hello {name}', brief(copy));
    const nobody = await own.post('/campaigns', { name: 'Nobody', text: 'x', audience: { minPoints: 999999 } });
    const nobodyStart = await own.post(`/campaigns/${nobody.data.data.id}/start`, {});
    check('starting a campaign that reaches nobody is refused in words', nobodyStart.status === 400 && plain(nobodyStart.data.message), brief(nobodyStart));
    const delDraft = await own.delete(`/campaigns/${nobody.data.data.id}`);
    check('a draft can be deleted', delDraft.status === 200 && (await prisma.campaign.count({ where: { id: nobody.data.data.id } })) === 0, brief(delDraft));
    const listed = await sales.http.get('/campaigns');
    check('a salesperson cannot see campaigns (not in their role)', listed.status === 403, brief(listed));

    const testSend = await campaigns.sendTest({ id: owner.id, clientId: SHOP, name: 'Owner Anand', permissions: ['*'], roles: ['SUPER_ADMIN'] }, { text: 'Hi {name}, {points} points' });
    const lastTest = sent[sent.length - 1];
    check('"send me a test" goes to the shop\'s own number only, marked [Test], with the sender\'s name', testSend.sent === true && lastTest.to === account.phone && /^\[Test\] Hi Owner, 250 points/.test(lastTest.text), JSON.stringify(lastTest));

    // After-sale notice (in this process, so the recorder sees it).
    await own.put('/loyalty/settings', { notifyAfterSale: true });
    const r5 = await sendAfterSaleNotice(SHOP, goodOrder.id);
    const notice = sent[sent.length - 1];
    check('the points message after a sale: from the shop, kind C9, says what she holds', r5 === 'sent' && notice.kind === 'C9' && /points/.test(notice.text) && /STOP/.test(notice.text), JSON.stringify(notice));
    const r6 = await sendAfterSaleNotice(SHOP, goodOrder.id);
    check('  ...sent once for a sale, however often asked', r6 === 'sent' && sent.filter(s => s.idempotencyKey === `LOYALTY:SALE:${goodOrder.id}`).length === 1);

    // ── I ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nI. THE DAILY JOB');
    const ist = new Date(Date.now() + 5.5 * 3600000);
    const todayMD = `${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
    await prisma.customer.update({ where: { id: crowd[1] }, data: { birthday: todayMD } });
    await prisma.customer.update({ where: { id: crowd[2] }, data: { anniversary: todayMD } });
    await prisma.customer.update({ where: { id: ravi.id }, data: { birthday: todayMD } }); // said STOP: gift yes, message no
    // A quiet customer: points untouched for 13 months.
    await prisma.$transaction(tx => import('../services/loyalty').then(l => l.post(tx, { clientId: SHOP, customerId: crowd[3], kind: 'ADJUSTED', points: 40, onceKey: `SEED:${crowd[3]}` })));
    await prisma.customer.update({ where: { id: crowd[3] }, data: { loyaltyActiveAt: new Date(Date.now() - 400 * 86400000) } });
    // One whose points lapse in exactly a week.
    await prisma.$transaction(tx => import('../services/loyalty').then(l => l.post(tx, { clientId: SHOP, customerId: crowd[4], kind: 'ADJUSTED', points: 70, onceKey: `SEED:${crowd[4]}` })));
    const lapseIn7 = new Date(Date.now() + 7 * 86400000); lapseIn7.setMonth(lapseIn7.getMonth() - 12);
    await prisma.customer.update({ where: { id: crowd[4] }, data: { loyaltyActiveAt: new Date(lapseIn7.getTime() + 3600000) } });
    await own.put('/loyalty/settings', { birthdayPoints: 100, birthdayWish: true, anniversaryWish: true, expiryReminder: true, birthdayText: 'Happy birthday {name}, from {shop}!' });

    const early = await prepareShopDay(SHOP, at(8));
    check('before 10 am the day is not prepared', early === null);
    const day = await prepareShopDay(SHOP, new Date(), { ignoreHours: true });
    check('the day is prepared once', !!day, JSON.stringify(day));
    const redo = await prepareShopDay(SHOP, new Date(), { ignoreHours: true });
    check('  ...and a second run the same day does nothing', redo === null);
    check('birthday gift: 100 points to both birthdays, Ravi too (STOP stops messages, not gifts)', day!.birthdayPoints === 2 && await pointsOf(crowd[1]) === 100 && await pointsOf(ravi.id) === 159, JSON.stringify(day));
    const wishes = await prisma.campaign.findFirst({ where: { clientId: SHOP, source: 'BIRTHDAY' }, include: { recipients: true } });
    check('  ...the wish goes only to the one who agreed, not to Ravi', wishes?.recipients.length === 1 && wishes.recipients[0].customerId === crowd[1] && /gift/.test(wishes.text), JSON.stringify(wishes?.recipients));
    const anniv = await prisma.campaign.findFirst({ where: { clientId: SHOP, source: 'ANNIVERSARY' }, include: { recipients: true } });
    check('anniversary wish: one', anniv?.recipients.length === 1 && anniv.recipients[0].customerId === crowd[2]);
    check('quiet for 13 months: points lapsed', day!.lapsed >= 1 && await pointsOf(crowd[3]) === 0 && (await prisma.loyaltyEntry.count({ where: { customerId: crowd[3], kind: 'EXPIRED' } })) === 1);
    const lapsing = await prisma.campaign.findFirst({ where: { clientId: SHOP, source: 'POINTS_EXPIRING' }, include: { recipients: true } });
    check('a week before lapsing: a reminder to that one customer', lapsing?.recipients.length === 1 && lapsing.recipients[0].customerId === crowd[4], JSON.stringify(lapsing?.recipients));
    const autoList = await own.get('/campaigns', { params: { source: 'AUTO' } });
    check('the automatic ones show in their own list, not among the shop\'s campaigns', autoList.data.data.length === 3 && (await own.get('/campaigns')).data.data.every((c: any) => c.source === 'MANUAL'), brief(autoList));
    await prisma.loyaltySettings.update({ where: { clientId: SHOP }, data: { autoPreparedFor: '2000-01-01' } });
    await prepareShopDay(SHOP, new Date(), { ignoreHours: true });
    check('the job run again on the same calendar day never gives the birthday gift twice', await pointsOf(crowd[1]) === 100);

    // ── J ──────────────────────────────────────────────────────────────────────────────────
    console.log('\nJ. ANOTHER SHOP');
    const peek = await stranger.http.get(`/campaigns/${cid}`);
    check('another shop cannot open this campaign', peek.status === 404, brief(peek));
    const peekPts = await stranger.http.get(`/loyalty/customers/${lakshmi.id}`);
    check('  ...nor see a customer\'s points', peekPts.status === 404, brief(peekPts));
    const peekAdj = await stranger.http.post(`/loyalty/customers/${lakshmi.id}/adjust`, { points: 1000, reason: 'mine now', nonce: crypto.randomUUID() });
    check('  ...nor give them points', peekAdj.status === 404 && await pointsOf(lakshmi.id) === 250, brief(peekAdj));
    const peekConsent = await stranger.http.put(`/campaigns/consent/${cashOnly.id}`, { agreed: false });
    check('  ...nor change whether they agreed', peekConsent.status === 404, brief(peekConsent));
    const theirs = await stranger.http.post('/campaigns/preview', { audience: {} });
    check('  ...and their "everyone" is nobody of ours', theirs.data.data.count === 0, brief(theirs));

    console.log('\nTHE BOOKS BALANCE');
    const off = await prisma.$queryRaw<{ id: string; held: number; summed: bigint }[]>`
      SELECT c.id, c.loyalty_points AS held, COALESCE(SUM(e.points), 0) AS summed
        FROM customers c LEFT JOIN loyalty_entries e ON e.customer_id = c.id
       WHERE c.client_id = ${SHOP} GROUP BY c.id HAVING c.loyalty_points <> COALESCE(SUM(e.points), 0)`;
    check('every customer\'s points equal the sum of their entries', off.length === 0, off);
    const lastBalance = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM customers c
       WHERE c.client_id = ${SHOP} AND EXISTS (SELECT 1 FROM loyalty_entries e WHERE e.customer_id = c.id)
         AND c.loyalty_points <> (SELECT balance FROM loyalty_entries e WHERE e.customer_id = c.id ORDER BY created_at DESC LIMIT 1)`;
    check('  ...and each one\'s newest entry shows exactly the balance they hold', Number(lastBalance[0].n) === 0, String(lastBalance[0].n));
  } finally {
    (whatsappClient as any).send = realSend;
    (whatsappClient as any).account = realAccount;
    await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
    await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch((e: any) => console.log('  (delete failed:', String(e?.message ?? e).slice(0, 300), ')'));
    const left = await prisma.loyaltyEntry.count({ where: { clientId: SHOP } }) + await prisma.campaign.count({ where: { clientId: SHOP } });
    check('the test shop is removed afterwards, points and campaigns too', left === 0, String(left));
  }

  console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
  if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
  process.exit(failures.length ? 1 : 0);
}

main().catch(async e => {
  console.error('\nSuite did not finish:', e?.stack ?? e);
  (whatsappClient as any).send = realSend;
  (whatsappClient as any).account = realAccount;
  await platformAdminService.deleteClientCompletely(SHOP, SHOP).catch(() => {});
  await platformAdminService.deleteClientCompletely(OTHER, OTHER).catch(() => {});
  process.exit(1);
});
