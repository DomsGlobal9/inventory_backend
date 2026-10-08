/**
 * Loyalty points and store credit spent at the till (contract §10), through the real API with a
 * till key, on a throwaway shop of its own.
 *
 *   A  the wallet: a walk-in is refused, an unknown number is a guest, a customer's usable
 *      points and credit come back with the arithmetic done, the name in full and the number masked
 *   B  reserving: the same key is the same hold; a second till meets NOT_ENOUGH; below the
 *      minimum and over the cap are refused in words; points off refused
 *   C  release and re-reserve (a parked bill); releasing a confirmed hold is refused
 *   D  confirm: idempotent; a swept hold answers HOLD_EXPIRED; a released one HOLD_RELEASED
 *   E  the sale: a bill naming its holds has them settled in the order's transaction (USED entries,
 *      balances down, holds tied to the order); it earns on money paid only; a bad or missing hold
 *      moves nothing and warns; the same event again changes nothing
 *   F  the sweep: a never-confirmed hold past its time is swept and the balance is usable again;
 *      a confirmed one is left alone however old
 *   G  store credit, the same way, and both on one bill
 *   H  a customer Inventory already knows (bought online, no till tag) is the same person at the
 *      till: the wallet finds their points and the bill lands on them, no second copy
 *   I  points on an exchange's new bill settle through the hold, like a sale
 *   M  a ₹0 bill with no payments is applied
 *   L  a split refund off by exactly the bill's round-off is the till's figure, with no warning
 *   K  /events/status carries what an applied bill did to the customer's points (for the receipt)
 *   U  udhaar: a credit bill earns on what was paid; each collection adds the rest, once
 *   J  the catalogue's shop logo and GST registration (null when never chosen); 0% bills warn only a registered shop
 *
 *   npx tsx src/scripts/verify-pos-holds.ts     (needs the local backend on :4006)
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { POS_BASE_URL } from '../utils/posConnection';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { applySale } from '../services/pos/pos-events.service';
import { applyExchange } from '../services/pos/pos-exchange.service';
import { applyReturn } from '../services/pos/pos-returns.service';
import { applyPaymentUpdate } from '../services/pos/pos-payments.service';
import { counterSaleService } from '../services/counter-sale/counter-sale.service';
import { sweep } from '../services/pos/pos-holds.service';
import { post as postPoints } from '../services/loyalty/loyalty.service';
import { post as postCredit } from '../services/store-credit/store-credit.service';

const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const BASE = `${API}/pos/v1`;
const STAMP = Date.now();
const CLIENT = `pos-holds-${STAMP}`;
const PRICE = 300000; // paise
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const api = (key: string) => axios.create({ baseURL: BASE, headers: { 'X-Storefront-Key': key }, validateStatus: () => true });
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 220)}`;

async function teardown() {
  const w = { clientId: CLIENT };
  const steps: [string, () => Promise<unknown>][] = [
    ['pos events', () => prisma.posInboundEvent.deleteMany({ where: w })],
    ['holds', () => prisma.posHold.deleteMany({ where: w })],
    ['payments', () => prisma.salesOrderPayment.deleteMany({ where: w })],
    ['loyalty', () => prisma.loyaltyEntry.deleteMany({ where: w })],
    ['credit', () => prisma.storeCreditEntry.deleteMany({ where: w })],
    ['return items', () => prisma.salesReturnItem.deleteMany({ where: { salesReturn: w } })],
    ['returns', () => prisma.salesReturn.deleteMany({ where: w })],
    ['orders', () => prisma.salesOrder.deleteMany({ where: w })],
    ['quotes', () => prisma.pricingQuote.deleteMany({ where: w })],
    ['transactions', () => prisma.inventoryTransaction.deleteMany({ where: w })],
    ['loyalty', () => prisma.loyaltyEntry.deleteMany({ where: w })],
    ['credit', () => prisma.storeCreditEntry.deleteMany({ where: w })],
    ['loyalty settings', () => prisma.loyaltySettings.deleteMany({ where: w })],
    ['customers', () => prisma.customer.deleteMany({ where: w })],
    ['stock', () => prisma.inventoryStock.deleteMany({ where: w })],
    ['variants', () => prisma.productVariant.deleteMany({ where: w })],
    ['products', () => prisma.product.deleteMany({ where: w })],
    ['connections', () => prisma.storefrontConnection.deleteMany({ where: w })],
    ['settings', () => prisma.clientSettings.deleteMany({ where: w })],
    ['locations', () => prisma.stockLocation.deleteMany({ where: w })]
  ];
  const left: string[] = [];
  for (const [label, run] of steps) { try { await run(); } catch (e: any) { left.push(`${label}: ${String(e.message).split('\n')[0]}`); } }
  console.log(left.length ? `\nteardown left behind -- ${left.join('; ')}` : '\nthrowaway shop removed');
}

async function main() {
  console.log(`\nPOS holds (points and store credit at the till), on ${CLIENT}\n`);
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Counter', code: `HOLD-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.clientSettings.create({ data: { clientId: CLIENT, businessName: 'Holds Test Shop', gstRegistration: 'UNREGISTERED' } });
  await prisma.loyaltySettings.create({ data: { clientId: CLIENT, enabled: true, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 100, maxRedeemPercent: 50, expiryMonths: 12, earnAtCounter: true } });
  const product = await prisma.product.create({ data: { clientId: CLIENT, productCode: `HP-${STAMP}`, slug: `hp-${STAMP}`, title: 'Hold saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 3000, status: 'ACTIVE' as any, publishedAt: new Date(), hsnCode: '5208', taxRateBps: 500 } });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, clientId: CLIENT, colorName: 'Indigo', size: 'Free Size', variantCode: `HV-${STAMP}`, sku: `HS-${STAMP}`, sellingPrice: 3000 } });
  await inventoryMutationService.applyMovement({ clientId: CLIENT, variantId: variant.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE', quantityDelta: 50, unitCost: 1200, notes: 'verify-pos-holds setup', createdBy: 'verify-pos-holds' });
  const phone = `+919${String(STAMP).slice(-9)}`;
  const cust = await prisma.customer.create({ data: { clientId: CLIENT, customerCode: `HC-${STAMP}`, name: 'Lakshmi Narayanan', phone, externalCustomerId: `POS:${phone}` } });
  await prisma.$transaction(tx => postPoints(tx, { clientId: CLIENT, customerId: cust.id, kind: 'ADJUSTED', points: 1250, onceKey: `SEED:${STAMP}`, note: 'seed' }));
  await prisma.$transaction(tx => postCredit(tx, { clientId: CLIENT, customerId: cust.id, kind: 'FROM_RETURN', amountPaise: 30000, onceKey: `SEEDC:${STAMP}`, note: 'seed' }));
  const t1 = await posConnectionService.create(CLIENT, { locationId: store.id, name: 'Till one' });
  const t2 = await posConnectionService.create(CLIENT, { locationId: store.id, name: 'Till two' });
  const A = api(t1.key), B = api(t2.key);
  const pointsOf = async () => (await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })).loyaltyPoints;
  const creditOf = async () => (await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })).storeCreditPaise;
  const holdRow = async (id: string) => prisma.posHold.findUniqueOrThrow({ where: { id } });
  const bill = (inv: string, qty: number, payments: any[]) => ({
    kind: 'sale.completed', invoiceNo: `INV/HOLD/${STAMP}-${inv}`, occurredAt: new Date().toISOString(), customer: { name: 'Lakshmi Narayanan', phone },
    lines: [{ itemCode: variant.variantCode, qty, unitPricePaise: PRICE, lineTotalPaise: PRICE * qty }], totals: {}, payments
  });
  const orderOf = async (inv: string) => prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, externalOrderId: `INV/HOLD/${STAMP}-${inv}` } });
  const entries = async (orderId: string) => prisma.loyaltyEntry.findMany({ where: { salesOrderId: orderId }, select: { kind: true, points: true } });

  try {
    console.log('\nA. THE WALLET');
    const a1 = await A.get('/wallet', { params: { billPaise: 540000 } });
    check('a walk-in (no customerRef) is refused in words', a1.status === 422 && /customerRef/.test(a1.data?.data?.detail ?? ''), brief(a1));
    const a2 = await A.get('/wallet', { params: { customerRef: '+919000000001', billPaise: 540000 } });
    check('an unknown number: no customer, a reason, never an error', a2.status === 200 && a2.data.data.points === null && a2.data.data.credit === null && /No customer/.test(a2.data.data.reason), brief(a2));
    const a3 = await A.get('/wallet', { params: { customerRef: phone, billPaise: 540000 } });
    const w = a3.data?.data;
    check('the customer: name in full, number masked, 1,250 points usable up to 50% of a Rs 5,400 bill = Rs 2,700', a3.status === 200 && w.customerName === 'Lakshmi Narayanan' && !w.customerRef.includes(phone.slice(3, 8)) && w.points.balance === 1250 && w.points.usablePoints === 1250 && w.points.usablePaise === 125000 && w.credit.balancePaise === 30000 && w.credit.usablePaise === 30000, brief(a3));
    const a4 = await A.get('/wallet', { params: { customerRef: phone, billPaise: 100000 } });
    check('a Rs 1,000 bill: points capped at 50% -> 500 points (Rs 500); credit capped at the bill', a4.data?.data?.points?.usablePoints === 500 && a4.data?.data?.points?.usablePaise === 50000 && a4.data?.data?.credit?.usablePaise === 30000, brief(a4));
    await prisma.loyaltySettings.update({ where: { clientId: CLIENT }, data: { enabled: false } });
    const a5 = await A.get('/wallet', { params: { customerRef: phone, billPaise: 100000 } });
    check('loyalty switched off for the shop: points null with a reason, credit still answered, never an error', a5.status === 200 && a5.data.data.points === null && /off for this shop/.test(a5.data.data.reason) && a5.data.data.credit?.balancePaise === 30000, brief(a5));
    const a6 = await A.post('/holds', { idempotencyKey: `off-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 100, billPaise: 100000 });
    check('  ...reserving points then: 422 POINTS_OFF', a6.status === 422 && a6.data?.data?.answer === 'POINTS_OFF', brief(a6));
    const a7 = await A.post('/holds', { idempotencyKey: `offc-${STAMP}`, customerRef: phone, kind: 'CREDIT', amount: 5000, billPaise: 100000 });
    check('  ...but store credit does not depend on loyalty: reserved', a7.status === 200 && a7.data.data.valuePaise === 5000, brief(a7));
    await A.delete(`/holds/${a7.data?.data?.holdId}`);
    await prisma.loyaltySettings.update({ where: { clientId: CLIENT }, data: { enabled: true } });

    console.log('\nB. RESERVING');
    const b1 = await A.post('/holds', { idempotencyKey: `k1-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 500, billPaise: 540000 });
    const h1 = b1.data?.data;
    check('500 points reserved: a holdId, Rs 500 off, expires in about 10 minutes', b1.status === 200 && h1.holdId && h1.valuePaise === 50000 && h1.status === 'RESERVED' && Date.parse(h1.expiresAt) - Date.now() > 9 * 60_000, brief(b1));
    check('  ...the ledger has NOT moved yet (the sale moves it)', await pointsOf() === 1250);
    const b2 = await A.post('/holds', { idempotencyKey: `k1-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 500, billPaise: 540000 });
    check('the same key again: the same hold, not a second one', b2.status === 200 && b2.data.data.holdId === h1.holdId, brief(b2));
    const b3 = await A.get('/wallet', { params: { customerRef: phone, billPaise: 540000 } });
    check('the wallet now shows 750 usable: the hold is taken out', b3.data?.data?.points?.balance === 750 && b3.data.data.points.usablePoints === 750, brief(b3));
    const b4 = await B.post('/holds', { idempotencyKey: `k2-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 800, billPaise: 540000 });
    check('a second till asking for 800 of the 750 left: 409 NOT_ENOUGH, in words', b4.status === 409 && b4.data?.data?.answer === 'NOT_ENOUGH' && /750/.test(b4.data?.data?.detail ?? ''), brief(b4));
    const b5 = await B.post('/holds', { idempotencyKey: `k3-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 700, billPaise: 540000 });
    check('the second till takes 700 of the 750: fine, 50 left', b5.status === 200 && b5.data.data.status === 'RESERVED', brief(b5));
    const b5b = await B.post('/holds', { idempotencyKey: `k3b-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 50, billPaise: 540000 });
    check('  ...and 50 left is under the 100 a customer needs to start using points: refused in words', b5b.status === 422 && /has 100.*They have 50/.test(b5b.data?.data?.detail ?? ''), brief(b5b));
    const b5c = await B.delete(`/holds/${b5.data.data.holdId}`);
    const b5w = await A.get('/wallet', { params: { customerRef: phone, billPaise: 540000 } });
    check('  ...the second till lets go: 750 usable again', b5c.status === 200 && b5w.data?.data?.points?.balance === 750, brief(b5w));
    const b6 = await B.post('/holds', { idempotencyKey: `k4-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 700, billPaise: 100000 });
    check('over the cap (50% of a Rs 1,000 bill): refused, naming the most allowed', b6.status === 422 && /500 points/.test(b6.data?.data?.detail ?? ''), brief(b6));
    const b7 = await B.post('/holds', { idempotencyKey: `k5-${STAMP}`, customerRef: '+919000000001', kind: 'POINTS', amount: 100, billPaise: 100000 });
    check('an unknown customer: 404 UNKNOWN_CUSTOMER', b7.status === 404 && b7.data?.data?.answer === 'UNKNOWN_CUSTOMER', brief(b7));
    const b8 = await B.post('/holds', { idempotencyKey: `k6-${STAMP}`, customerRef: phone, kind: 'GOLD', amount: 100, billPaise: 100000 });
    check('a kind that is not POINTS or CREDIT: refused', b8.status === 422, brief(b8));

    console.log('\nC. A PARKED BILL');
    const c1 = await A.delete(`/holds/${h1.holdId}`);
    check('parking releases the hold', c1.status === 200 && c1.data.data.status === 'RELEASED', brief(c1));
    const c2 = await A.get('/wallet', { params: { customerRef: phone, billPaise: 540000 } });
    check('  ...and the 500 are usable again', c2.data?.data?.points?.balance === 1250, brief(c2));
    const c3 = await A.delete(`/holds/${h1.holdId}`);
    check('releasing it again changes nothing', c3.status === 200 && c3.data.data.status === 'RELEASED', brief(c3));
    const c4 = await A.post('/holds', { idempotencyKey: `k1-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 500, billPaise: 540000 });
    check('the old key after a release still answers the released hold (the till reads its status)', c4.status === 200 && c4.data.data.status === 'RELEASED', brief(c4));
    const c5 = await A.post('/holds', { idempotencyKey: `k7-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 500, billPaise: 540000 });
    const h2 = c5.data?.data;
    check('recall re-reserves with a new key: a new hold', c5.status === 200 && h2.holdId && h2.holdId !== h1.holdId && h2.status === 'RESERVED', brief(c5));

    console.log('\nD. CONFIRM');
    const d1 = await A.post(`/holds/${h2.holdId}/confirm`, { invoiceNo: `INV/HOLD/${STAMP}-E1`, occurredAt: new Date().toISOString() });
    check('the sale committed on the till: the hold is CONFIRMED', d1.status === 200 && d1.data.data.status === 'CONFIRMED' && d1.data.data.confirmedAt, brief(d1));
    const d2 = await A.post(`/holds/${h2.holdId}/confirm`, { invoiceNo: `INV/HOLD/${STAMP}-E1` });
    check('  ...confirming again is the same answer', d2.status === 200 && d2.data.data.confirmedAt === d1.data.data.confirmedAt, brief(d2));
    const d3 = await A.delete(`/holds/${h2.holdId}`);
    check('a confirmed hold cannot be released', d3.status === 409 && d3.data?.data?.answer === 'HOLD_CONFIRMED', brief(d3));
    const d4 = await A.post(`/holds/${h1.holdId}/confirm`, {});
    check('confirming a released hold: 409 HOLD_RELEASED', d4.status === 409 && d4.data?.data?.answer === 'HOLD_RELEASED', brief(d4));
    const d5 = await A.post(`/holds/00000000-0000-4000-8000-000000000000/confirm`, {});
    check('a hold Inventory never gave: 404', d5.status === 404 && d5.data?.data?.answer === 'HOLD_UNKNOWN', brief(d5));
    const d6 = await A.get('/wallet', { params: { customerRef: phone, billPaise: 540000 } });
    check('a confirmed hold still occupies the balance until its bill lands (750 usable)', d6.data?.data?.points?.balance === 750, brief(d6));

    console.log('\nE. THE SALE LANDS');
    let pts = 1250; // what the ledger should hold, carried along (1 point per Rs 100 paid in money)
    const e1: any = await applySale(CLIENT, store.id, bill('E1', 2, [{ method: 'POINTS', amountPaise: 50000, holdId: h2.holdId }, { method: 'CASH', amountPaise: 550000 }]) as any);
    pts += -500 + 55;
    const o1 = await orderOf('E1');
    const en1 = await entries(o1.id);
    const hr1 = await holdRow(h2.holdId);
    check('applied with no warnings; 500 points USED and 55 earned on the Rs 5,500 paid in money; the hold tied to the order',
      e1?.answer === 'APPLIED' && !(e1?.warnings?.length) && en1.some(e => e.kind === 'USED' && e.points === -500) && en1.some(e => e.kind === 'EARNED' && e.points === 55) && await pointsOf() === pts && hr1.salesOrderId === o1.id && hr1.status === 'CONFIRMED',
      `${e1?.answer} ${JSON.stringify(e1?.warnings)} entries=${JSON.stringify(en1)} pts=${await pointsOf()} hold=${hr1.status}/${hr1.salesOrderId}`);
    const e1b: any = await applySale(CLIENT, store.id, bill('E1', 2, [{ method: 'POINTS', amountPaise: 50000, holdId: h2.holdId }, { method: 'CASH', amountPaise: 550000 }]) as any);
    check('the same event again: ALREADY_APPLIED, nothing moves', e1b?.answer === 'ALREADY_APPLIED' && await pointsOf() === pts, `${e1b?.answer} pts=${await pointsOf()}`);
    const e2: any = await applySale(CLIENT, store.id, bill('E2', 1, [{ method: 'POINTS', amountPaise: 20000 }, { method: 'CASH', amountPaise: 280000 }]) as any);
    pts += 28;
    check('a POINTS row with no hold: applied, warned, no points taken; earns on the Rs 2,800 paid in money (28)', e2?.answer === 'APPLIED' && (e2?.warnings ?? []).some((w: string) => /names no hold/.test(w)) && await pointsOf() === pts, `${e2?.answer} ${JSON.stringify(e2?.warnings)} pts=${await pointsOf()}`);
    const e3: any = await applySale(CLIENT, store.id, bill('E3', 1, [{ method: 'POINTS', amountPaise: 50000, holdId: h2.holdId }, { method: 'CASH', amountPaise: 250000 }]) as any);
    pts += 25;
    check('a hold already used by another bill: applied, warned, nothing taken', e3?.answer === 'APPLIED' && (e3?.warnings ?? []).some((w: string) => /already used by another bill/.test(w)) && await pointsOf() === pts, `${e3?.answer} ${JSON.stringify(e3?.warnings)} pts=${await pointsOf()}`);
    const e4: any = await applySale(CLIENT, store.id, bill('E4', 1, [{ method: 'POINTS', amountPaise: 50000, holdId: '00000000-0000-4000-8000-000000000000' }, { method: 'CASH', amountPaise: 250000 }]) as any);
    pts += 25;
    check('a hold Inventory never gave: applied, warned, nothing taken', e4?.answer === 'APPLIED' && (e4?.warnings ?? []).some((w: string) => /not one Inventory gave/.test(w)) && await pointsOf() === pts, `${e4?.answer} ${JSON.stringify(e4?.warnings)} pts=${await pointsOf()}`);
    const held5 = await A.post('/holds', { idempotencyKey: `k8-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 300, billPaise: 300000 });
    const e5: any = await applySale(CLIENT, store.id, bill('E5', 1, [{ method: 'POINTS', amountPaise: 20000, holdId: held5.data.data.holdId }, { method: 'CASH', amountPaise: 280000 }]) as any);
    pts += -300 + 28;
    check('the row says Rs 200 but the hold reserved Rs 300: settled at the hold, with a warning; earns on the Rs 2,800 the till took in money', e5?.answer === 'APPLIED' && (e5?.warnings ?? []).some((w: string) => /reserved/.test(w)) && (await entries((await orderOf('E5')).id)).some(e => e.kind === 'USED' && e.points === -300) && await pointsOf() === pts, `${e5?.answer} ${JSON.stringify(e5?.warnings)} pts=${await pointsOf()}`);
    const e6: any = await applySale(CLIENT, store.id, { ...bill('E6', 1, [{ method: 'CASH', amountPaise: 300000 }]), customer: null } as any);
    check('a walk-in bill with no points: applied, nothing to settle', e6?.answer === 'APPLIED' && !(e6?.warnings?.length), `${e6?.answer} ${JSON.stringify(e6?.warnings)}`);

    console.log('\nF. THE SWEEP');
    const f0 = await A.post('/holds', { idempotencyKey: `k9-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 200, billPaise: 300000 });
    const stale = f0.data.data.holdId;
    await prisma.posHold.update({ where: { id: stale }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const f1 = await A.get('/wallet', { params: { customerRef: phone, billPaise: 300000 } });
    check('a never-confirmed hold past its time is swept on the next wallet read: the balance is usable again', f1.data?.data?.points?.balance === await pointsOf() && (await holdRow(stale)).status === 'SWEPT', brief(f1));
    const f2 = await A.post(`/holds/${stale}/confirm`, { invoiceNo: 'late' });
    check('confirming a swept hold: 409 HOLD_EXPIRED, in words', f2.status === 409 && f2.data?.data?.answer === 'HOLD_EXPIRED', brief(f2));
    const f3 = await A.post('/holds', { idempotencyKey: `k10-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 200, billPaise: 300000 });
    await A.post(`/holds/${f3.data.data.holdId}/confirm`, { invoiceNo: 'slow-event' });
    await prisma.posHold.update({ where: { id: f3.data.data.holdId }, data: { expiresAt: new Date(Date.now() - 3600_000) } });
    const swept = await sweep();
    check('the housekeeping sweep leaves a confirmed hold alone, however old (its sale event may take hours)', (await holdRow(f3.data.data.holdId)).status === 'CONFIRMED', `swept=${swept} status=${(await holdRow(f3.data.data.holdId)).status}`);
    const f4: any = await applySale(CLIENT, store.id, bill('F4', 1, [{ method: 'POINTS', amountPaise: 20000, holdId: f3.data.data.holdId }, { method: 'CASH', amountPaise: 280000 }]) as any);
    pts += -200 + 28;
    check('  ...and its bill, arriving an hour later, still settles the points', f4?.answer === 'APPLIED' && !(f4?.warnings?.length) && (await holdRow(f3.data.data.holdId)).salesOrderId != null && await pointsOf() === pts, `${f4?.answer} ${JSON.stringify(f4?.warnings)} pts=${await pointsOf()}`);

    console.log('\nG. STORE CREDIT, AND BOTH ON ONE BILL');
    const g1 = await A.post('/holds', { idempotencyKey: `c1-${STAMP}`, customerRef: phone, kind: 'CREDIT', amount: 20000, billPaise: 300000 });
    check('Rs 200 of credit reserved', g1.status === 200 && g1.data.data.valuePaise === 20000, brief(g1));
    const g2 = await B.post('/holds', { idempotencyKey: `c2-${STAMP}`, customerRef: phone, kind: 'CREDIT', amount: 20000, billPaise: 300000 });
    check('a second till asking for Rs 200 of the Rs 100 left: 409 NOT_ENOUGH', g2.status === 409 && g2.data?.data?.answer === 'NOT_ENOUGH', brief(g2));
    const g3 = await A.post('/holds', { idempotencyKey: `c3-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 100, billPaise: 300000 });
    const g4: any = await applySale(CLIENT, store.id, bill('G4', 1, [{ method: 'CREDIT', amountPaise: 20000, holdId: g1.data.data.holdId }, { method: 'POINTS', amountPaise: 10000, holdId: g3.data.data.holdId }, { method: 'CASH', amountPaise: 270000 }]) as any);
    pts += -100 + 27;
    const o4 = await orderOf('G4');
    const ce = await prisma.storeCreditEntry.findMany({ where: { salesOrderId: o4.id }, select: { kind: true, amountPaise: true } });
    check('credit and points on one bill: both settled, credit balance Rs 100, earned on the Rs 2,700 paid in money (27)', g4?.answer === 'APPLIED' && !(g4?.warnings?.length) && ce.some(e => e.kind === 'USED' && e.amountPaise === -20000) && await creditOf() === 10000 && (await entries(o4.id)).some(e => e.kind === 'EARNED' && e.points === 27) && await pointsOf() === pts, `${g4?.answer} ${JSON.stringify(g4?.warnings)} credit=${await creditOf()} entries=${JSON.stringify(await entries(o4.id))}`);

    console.log('\nH. A CUSTOMER INVENTORY ALREADY KNOWS');
    const onlinePhone = `+918${String(STAMP).slice(-9)}`;
    const buyer = await prisma.customer.create({ data: { clientId: CLIENT, customerCode: `HB-${STAMP}`, name: 'Online Buyer', phone: onlinePhone } });
    await prisma.$transaction(tx => postPoints(tx, { clientId: CLIENT, customerId: buyer.id, kind: 'ADJUSTED', points: 300, onceKey: `SEEDB:${STAMP}`, note: 'seed' }));
    const hb1 = await A.get('/wallet', { params: { customerRef: onlinePhone, billPaise: 300000 } });
    check('the till asks with their phone: the wallet finds THEM, by name, with their 300 points', hb1.status === 200 && hb1.data.data.customerName === 'Online Buyer' && hb1.data.data.points?.balance === 300, brief(hb1));
    const hHold = await A.post('/holds', { idempotencyKey: `hb-${STAMP}`, customerRef: onlinePhone, kind: 'POINTS', amount: 100, billPaise: 300000 });
    const customersBefore = await prisma.customer.count({ where: { clientId: CLIENT } });
    const hb2: any = await applySale(CLIENT, store.id, { ...bill('H2', 1, [{ method: 'POINTS', amountPaise: 10000, holdId: hHold.data?.data?.holdId }, { method: 'CASH', amountPaise: 290000 }]), customer: { name: 'Buyer at the till', phone: onlinePhone } } as any);
    const oH = await orderOf('H2');
    const buyerAfter = await prisma.customer.findUniqueOrThrow({ where: { id: buyer.id } });
    check('their till bill lands on the same customer, no second copy is made, and the points settle: 300 - 100 + 29 = 229',
      hb2?.answer === 'APPLIED' && !(hb2?.warnings?.length) && oH.customerId === buyer.id && await prisma.customer.count({ where: { clientId: CLIENT } }) === customersBefore && buyerAfter.loyaltyPoints === 229,
      `${hb2?.answer} ${JSON.stringify(hb2?.warnings)} order.customer=${oH.customerId === buyer.id ? 'same' : 'OTHER'} customers ${customersBefore}->${await prisma.customer.count({ where: { clientId: CLIENT } })} pts=${buyerAfter.loyaltyPoints}`);

    const hq = await A.post('/quote', { lines: [{ itemCode: variant.variantCode, qty: 1 }], customerRef: onlinePhone });
    const hqRow = hq.data?.data?.quoteId ? await prisma.pricingQuote.findUnique({ where: { id: hq.data.data.quoteId }, select: { customerId: true } }) : null;
    check('  ...and the offer quote prices for the same customer (so a group offer reaches them at the till)', hq.status === 200 && hqRow?.customerId === buyer.id, `${brief(hq)} quote.customer=${hqRow?.customerId === buyer.id ? 'same' : hqRow?.customerId}`);

    console.log('\nI. POINTS ON AN EXCHANGE');
    const x1: any = await applySale(CLIENT, store.id, bill('X1', 1, [{ method: 'CASH', amountPaise: 300000 }]) as any);
    pts += 30;
    const xHold = await A.post('/holds', { idempotencyKey: `xh-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 200, billPaise: 300000 });
    const ex: any = await applyExchange(CLIENT, store.id, {
      kind: 'sale.exchanged', exchangeNo: `INV/HOLD/${STAMP}-X2`, againstInvoiceNo: `INV/HOLD/${STAMP}-X1`, occurredAt: new Date().toISOString(),
      returned: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: PRICE }],
      sold: [{ itemCode: variant.variantCode, qty: 2, unitPricePaise: PRICE, lineTotalPaise: PRICE * 2 }],
      payments: [{ method: 'POINTS', amountPaise: 20000, holdId: xHold.data?.data?.holdId }, { method: 'CASH', amountPaise: 280000 }],
      customer: { name: 'Lakshmi Narayanan', phone }
    } as any);
    const oX = await orderOf('X2');
    const xEntries = await entries(oX.id);
    const xh = await holdRow(xHold.data?.data?.holdId);
    check('the new bill of an exchange takes its points through the hold: USED -200 on the new bill, the hold tied to it, on the same customer',
      x1?.answer === 'APPLIED' && ['APPLIED'].includes(ex?.answer) && xEntries.some(e => e.kind === 'USED' && e.points === -200) && xh.salesOrderId === oX.id && oX.customerId === cust.id && !(ex?.warnings ?? []).some((w: string) => /hold|points/i.test(w)),
      `${x1?.answer}/${ex?.answer} ${JSON.stringify(ex?.warnings)} entries=${JSON.stringify(xEntries)} hold=${xh.status}/${xh.salesOrderId === oX.id}`);

    // A points-paid bill exchanged: what settles is the money share only, and a short payment is said out loud.
    const xpHold = await A.post('/holds', { idempotencyKey: `xp-${STAMP}`, customerRef: phone, kind: 'POINTS', amount: 100, billPaise: 300000 });
    await applySale(CLIENT, store.id, bill('XP1', 1, [{ method: 'POINTS', amountPaise: 10000, holdId: xpHold.data?.data?.holdId }, { method: 'CASH', amountPaise: 290000 }]) as any);
    const exShort: any = await applyExchange(CLIENT, store.id, {
      kind: 'sale.exchanged', exchangeNo: `INV/HOLD/${STAMP}-XP2`, againstInvoiceNo: `INV/HOLD/${STAMP}-XP1`, occurredAt: new Date().toISOString(),
      returned: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: PRICE }],
      sold: [{ itemCode: variant.variantCode, qty: 2, unitPricePaise: PRICE, lineTotalPaise: PRICE * 2 }],
      payments: [{ method: 'CASH', amountPaise: 300000 }],
      customer: { name: 'Lakshmi Narayanan', phone }
    } as any);
    const xpSettle = await prisma.salesOrderPayment.findFirst({ where: { clientId: CLIENT, kind: 'PAYMENT', method: 'CREDIT', settlesReturnId: { not: null }, salesOrder: { externalOrderId: `INV/HOLD/${STAMP}-XP2` } }, select: { amount: true } });
    check('exchanging a bill paid partly with points settles only the money share (₹3,000 - ₹100 of points = ₹2,900)', Number(xpSettle?.amount) === 2900, JSON.stringify(xpSettle));
    check('  ...and the till taking ₹3,000 where ₹3,100 was owed is warned, naming the ₹100 still due', exShort?.answer === 'APPLIED' && (exShort?.warnings ?? []).some((w: string) => /owed 3100\.00/.test(w) && /100\.00 still due/.test(w)), JSON.stringify(exShort?.warnings));

    console.log('\nJ. WHAT THE CATALOGUE SAYS ABOUT THE SHOP, AND 0% BILLS');
    const shopOf = async () => (await A.get('/catalogue', { params: { limit: 1 } })).data?.data;
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { logoUrl: 'https://example.com/logo.png', gstRegistration: 'UNREGISTERED', gstNumber: null } });
    const j1 = await shopOf();
    check('the catalogue carries the shop logo for the till to print', j1?.shop?.logoUrl === 'https://example.com/logo.png', JSON.stringify(j1?.shop));
    check('  ...a shop that chose "not registered" says UNREGISTERED', j1?.gst?.registration === 'UNREGISTERED', JSON.stringify(j1?.gst));
    // A real stored logo (uploads are kept as WebP): the till's PDF gets a PNG copy through the till door.
    const realLogo = (await prisma.clientSettings.findUnique({ where: { clientId: 'sphl' }, select: { logoUrl: true } }))?.logoUrl;
    if (realLogo) {
      await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { logoUrl: realLogo } });
      const jl = await shopOf();
      const printed = jl?.shop?.logoPrintUrl ? await axios.get(jl.shop.logoPrintUrl, { headers: { 'X-Storefront-Key': t1.key }, responseType: 'arraybuffer', validateStatus: () => true }) : null;
      const bytes = printed ? Buffer.from(printed.data) : Buffer.alloc(0);
      check('the catalogue also gives a print copy of the logo, and it really is a PNG (fetched with the till key)',
        printed?.status === 200 && bytes.subarray(0, 4).toString('hex') === '89504e47', `${printed?.status} ${jl?.shop?.logoPrintUrl} first bytes ${bytes.subarray(0, 12).toString('hex')}`);
      const noKey = jl?.shop?.logoPrintUrl ? await axios.get(jl.shop.logoPrintUrl, { validateStatus: () => true }) : null;
      check('  ...and only with a till key', noKey?.status === 401 || noKey?.status === 403, String(noKey?.status));
    } else {
      check('a real stored logo to convert exists (sphl)', false, 'sphl has no logo');
    }
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { gstNumber: '29ABCDE1234F1Z5' } });
    const j2 = await shopOf();
    check('  ...UNREGISTERED beside a GSTIN means the owner never chose: registration null, so the till keeps its own', j2?.gst?.registration === null, JSON.stringify(j2?.gst));
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { gstRegistration: 'REGULAR' } });
    const j3 = await shopOf();
    check('  ...a registered shop says REGULAR', j3?.gst?.registration === 'REGULAR', JSON.stringify(j3?.gst));
    // Rule 46 on Inventory's receipt: each line's rate, the taxable value and CGST/SGST per rate, as stored.
    const gb: any = await applySale(CLIENT, store.id, { ...bill('J3B', 1, [{ method: 'CASH', amountPaise: PRICE }]), customer: null, lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: PRICE, lineTotalPaise: PRICE, taxRateBps: 500, taxPaise: 14286 }] } as any);
    const oGB = await prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, externalOrderId: `INV/HOLD/${STAMP}-J3B` }, select: { id: true, items: { select: { taxableValue: true, cgst: true, sgst: true } } } });
    const rGB: any = await counterSaleService.getSale(CLIENT, oGB.id);
    const stored = oGB.items[0];
    check('a GST bill\'s receipt carries the line rate (5%) and, per rate, the taxable value, CGST and SGST exactly as stored',
      gb?.answer === 'APPLIED' && rGB?.items?.[0]?.taxRateBps === 500 && rGB?.gst?.length === 1 && rGB.gst[0].rateBps === 500
        && Math.abs(rGB.gst[0].taxable - Number(stored.taxableValue)) < 0.001 && Math.abs(rGB.gst[0].cgst - Number(stored.cgst)) < 0.001 && Math.abs(rGB.gst[0].sgst - Number(stored.sgst)) < 0.001,
      `${gb?.answer} ${JSON.stringify(rGB?.gst)} stored=${JSON.stringify(stored)}`);
    const plain: any = await counterSaleService.getSale(CLIENT, (await prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, externalOrderId: `INV/HOLD/${STAMP}-E6` }, select: { id: true } })).id);
    check('  ...a bill that charged no GST has no GST lines on its receipt (GST is optional)', Array.isArray(plain?.gst) && plain.gst.length === 0, JSON.stringify(plain?.gst));
    const zero = (inv: string) => ({ ...bill(inv, 1, [{ method: 'CASH', amountPaise: PRICE }]), customer: null, lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: PRICE, lineTotalPaise: PRICE, taxRateBps: 0, taxPaise: 0 }] });
    const j4: any = await applySale(CLIENT, store.id, zero('J4') as any);
    check('a registered shop billed at 0% on a 5% product: warned (tax owed and not collected)', j4?.answer === 'APPLIED' && (j4?.warnings ?? []).some((w: string) => /0% GST/.test(w)), JSON.stringify(j4?.warnings));
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { gstRegistration: 'COMPOSITION', gstNumber: '29ABCDE1234F1Z5' } });
    const j5: any = await applySale(CLIENT, store.id, zero('J5') as any);
    check('a composition shop billed at 0% (a Bill of Supply): no GST warning', j5?.answer === 'APPLIED' && !(j5?.warnings ?? []).some((w: string) => /GST/.test(w)), JSON.stringify(j5?.warnings));
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { gstRegistration: 'UNREGISTERED', gstNumber: null } });
    const j6: any = await applySale(CLIENT, store.id, zero('J6') as any);
    check('an unregistered shop billed at 0% (a plain receipt): no GST warning', j6?.answer === 'APPLIED' && !(j6?.warnings ?? []).some((w: string) => /GST/.test(w)), JSON.stringify(j6?.warnings));
    // GST is optional (owner's rule): "registered" with no GSTIN on file charges nothing and issues a plain receipt.
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { gstRegistration: 'REGULAR', gstNumber: null } });
    const j7: any = await applySale(CLIENT, store.id, zero('J7') as any);
    const o7 = await prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, externalOrderId: `INV/HOLD/${STAMP}-J7` }, select: { documentKind: true } });
    check('a shop marked registered but with no GSTIN: a plain RECEIPT, and no GST warning on a 0% bill', j7?.answer === 'APPLIED' && o7.documentKind === 'RECEIPT' && !(j7?.warnings ?? []).some((w: string) => /GST/.test(w)), `${o7.documentKind} ${JSON.stringify(j7?.warnings)}`);
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { gstRegistration: 'UNREGISTERED' } });

    console.log('\nK. POINTS ON THE RECEIPT (/events/status)');
    const statusOf = async (inv: string) => {
      await prisma.posInboundEvent.create({ data: { clientId: CLIENT, locationId: store.id, kind: 'sale.completed', invoiceNo: `INV/HOLD/${STAMP}-${inv}`, payload: {}, status: 'APPLIED', answer: 'APPLIED', settledAt: new Date() } });
      return (await A.get('/events/status', { params: { invoiceNo: `INV/HOLD/${STAMP}-${inv}` } })).data?.data;
    };
    const k1 = await statusOf('E1');
    const e1Balance = (await prisma.loyaltyEntry.findFirst({ where: { salesOrderId: o1.id, kind: 'EARNED' }, select: { balance: true } }))?.balance;
    check('an applied bill with a customer: earned 55, used 500, and the balance right after the bill', JSON.stringify(k1?.points) === JSON.stringify({ earned: 55, used: 500, balanceAfter: e1Balance }), JSON.stringify(k1?.points) + ` want balance ${e1Balance}`);
    const k2 = await statusOf('E6');
    check('  ...a walk-in bill: points null', k2 && k2.points === null, JSON.stringify(k2?.points));

    console.log('\nL. A RETURN OFF BY THE BILL\'S ROUND-OFF');
    // A ₹3,000.10 line rounded down to ₹3,000 on the bill: the 10 paise never changed hands.
    const roundBill = (inv: string) => ({ ...bill(inv, 1, [{ method: 'CASH', amountPaise: 300000 }]), customer: null, lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: 300010, lineTotalPaise: 300010 }], totals: { roundOffPaise: -10 } });
    for (const inv of ['L1', 'L2']) {
      const made: any = await applySale(CLIENT, store.id, roundBill(inv) as any);
      await prisma.posInboundEvent.create({ data: { clientId: CLIENT, locationId: store.id, kind: 'sale.completed', invoiceNo: `INV/HOLD/${STAMP}-${inv}`, payload: roundBill(inv) as any, status: 'APPLIED', answer: 'APPLIED', settledAt: new Date() } });
      if (made?.answer !== 'APPLIED') console.log('  (setup bill', inv, made?.answer, ')');
    }
    const oL1 = await prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, externalOrderId: `INV/HOLD/${STAMP}-L1` }, select: { id: true, total: true, roundOff: true } });
    const rL1: any = await counterSaleService.getSale(CLIENT, oL1.id);
    check('a bill rounded down by 10 paise keeps its round-off, reads PAID with nothing due, and its receipt totals what was paid (₹3,000)',
      Number(oL1.roundOff) === -0.1 && rL1?.payment?.status === 'PAID' && rL1?.payment?.due === 0 && rL1?.roundOff === -0.1 && Math.abs(rL1?.total - 3000) < 0.001,
      `roundOff=${oL1.roundOff} total=${oL1.total} receipt=${JSON.stringify({ t: rL1?.total, r: rL1?.roundOff, p: rL1?.payment })}`);
    const giveBack = (cn: string, inv: string, paise: number) => ({ kind: 'sale.returned', creditNoteNo: `CN/HOLD/${STAMP}-${cn}`, againstInvoiceNo: `INV/HOLD/${STAMP}-${inv}`, lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300010 }], totals: { roundOffPaise: 10 }, refunds: [{ method: 'CASH', amountPaise: paise }] });
    const l1: any = await applyReturn(CLIENT, store.id, giveBack('L1', 'L1', 300000) as any);
    const l1rows = await prisma.salesOrderPayment.findMany({ where: { clientId: CLIENT, kind: 'REFUND', salesOrder: { externalOrderId: `INV/HOLD/${STAMP}-L1` } }, select: { method: true, amount: true } });
    check('a full return that gives back ₹3,000 for a ₹3,000.10 line rounded to ₹3,000: no warning, recorded as the till gave it (₹3,000.00)',
      l1?.answer === 'APPLIED' && !(l1?.warnings?.length) && l1rows.length === 1 && Number(l1rows[0].amount) === 3000,
      `${l1?.answer} ${JSON.stringify(l1?.warnings)} rows=${JSON.stringify(l1rows)}`);
    const l2: any = await applyReturn(CLIENT, store.id, giveBack('L2', 'L2', 299950) as any);
    check('  ...but a till that gives back 50 paise less than that still gets the warning', l2?.answer === 'APPLIED' && (l2?.warnings ?? []).some((w: string) => /gave back/.test(w)), `${l2?.answer} ${JSON.stringify(l2?.warnings)}`);

    console.log('\nM. A ₹0 BILL (A GIFT OR A REPLACEMENT)');
    const pointsBeforeGift = await pointsOf();
    const m1: any = await applySale(CLIENT, store.id, { ...bill('M1', 1, []), lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: PRICE, lineTotalPaise: 0 }], payments: [] } as any);
    const oM = await orderOf('M1').catch(() => null);
    check('a fully discounted bill with no payments is applied, never refused (a refusal would stop the shop\'s queue)',
      m1?.answer === 'APPLIED' && oM != null && Number(oM.total) === 0, `${m1?.answer} ${m1?.detail ?? ''} total=${oM?.total}`);
    check('  ...earns nothing and takes nothing', await pointsOf() === pointsBeforeGift, `${pointsBeforeGift} -> ${await pointsOf()}`);

    console.log('\nN. THE BILL\'S SHOP DETAILS FOLLOW INVENTORY; A B2B BUYER IS KEPT (GST STAYS OPTIONAL)');
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { businessName: 'Holds Silks', businessAddress: '1 Shop Road', businessPhone: '+919000000010', gstNumber: null, receiptFooter: 'Thank you' } });
    const n1 = (await A.get('/catalogue', { params: { limit: 1 } })).data?.data?.shop;
    check('no store address: the shop\'s name, address, phone and footer; GSTIN null (none set, and that is fine)',
      n1?.name === 'Holds Silks' && n1?.address === '1 Shop Road' && n1?.phone === '+919000000010' && n1?.receiptFooter === 'Thank you' && n1?.gstin === null, JSON.stringify(n1));
    await prisma.stockLocation.update({ where: { id: store.id }, data: { address: '22 Store Street', phone: '+919000000022' } });
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { gstNumber: '36AAAAA0000A1Z5' } });
    const n2 = (await A.get('/catalogue', { params: { limit: 1 } })).data?.data?.shop;
    check('  ...the till\'s own store\'s address and phone come first; the GSTIN once the owner sets it',
      n2?.address === '22 Store Street' && n2?.phone === '+919000000022' && n2?.gstin === '36AAAAA0000A1Z5', JSON.stringify(n2));

    const b2b: any = await applySale(CLIENT, store.id, { ...bill('N1', 1, [{ method: 'CASH', amountPaise: PRICE }]), customer: { name: 'Lakshmi Traders', phone, gstin: '36aabcl1234q1z5', address: '5 Market Lane, Hyderabad' } } as any);
    const oN = await prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, externalOrderId: `INV/HOLD/${STAMP}-N1` }, select: { id: true, buyerName: true, buyerGstin: true, buyerAddress: true } });
    const custN = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id }, select: { gstNumber: true, billingAddress: true } });
    check('a B2B bill: the buyer as issued is frozen on the order (GSTIN in capitals), and the customer\'s empty GSTIN and address are filled',
      b2b?.answer === 'APPLIED' && oN.buyerName === 'Lakshmi Traders' && oN.buyerGstin === '36AABCL1234Q1Z5' && oN.buyerAddress === '5 Market Lane, Hyderabad' && custN.gstNumber === '36AABCL1234Q1Z5' && custN.billingAddress === '5 Market Lane, Hyderabad',
      `${b2b?.answer} ${JSON.stringify(oN)} ${JSON.stringify(custN)}`);
    const rN: any = await counterSaleService.getSale(CLIENT, oN.id);
    check('  ...and Inventory\'s receipt for it carries "Bill to"', rN?.buyer?.gstin === '36AABCL1234Q1Z5' && rN?.buyer?.name === 'Lakshmi Traders', JSON.stringify(rN?.buyer));
    await prisma.customer.update({ where: { id: cust.id }, data: { gstNumber: '36ZZZZZ9999Z1Z5' } });
    await applySale(CLIENT, store.id, { ...bill('N2', 1, [{ method: 'CASH', amountPaise: PRICE }]), customer: { name: 'Lakshmi Traders', phone, gstin: '36AABCL1234Q1Z5', address: 'x' } } as any);
    check('  ...a customer GSTIN the owner already has is never overwritten by a bill', (await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })).gstNumber === '36ZZZZZ9999Z1Z5');
    const b2c: any = await applySale(CLIENT, store.id, bill('N3', 1, [{ method: 'CASH', amountPaise: PRICE }]) as any);
    const oN3 = await prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, externalOrderId: `INV/HOLD/${STAMP}-N3` }, select: { id: true, buyerGstin: true, buyerName: true } });
    const rN3: any = await counterSaleService.getSale(CLIENT, oN3.id);
    check('an ordinary bill with no GSTIN: applied, no buyer stored, no "Bill to" (GST is optional)', b2c?.answer === 'APPLIED' && oN3.buyerGstin === null && oN3.buyerName === null && rN3?.buyer === null, JSON.stringify({ oN3, buyer: rN3?.buyer }));

    const big: any = await applySale(CLIENT, store.id, { ...bill('N4', 1, [{ method: 'CASH', amountPaise: PRICE }]), customer: { name: 'Kavya R', phone: '+916300000044', address: '9 Lake View\nChennai 600001' } } as any);
    const oN4 = await prisma.salesOrder.findFirstOrThrow({ where: { clientId: CLIENT, externalOrderId: `INV/HOLD/${STAMP}-N4` }, select: { id: true, buyerName: true, buyerGstin: true, buyerAddress: true } });
    const rN4: any = await counterSaleService.getSale(CLIENT, oN4.id);
    check('a large bill to a customer with no GSTIN, address given: name and address frozen, no GSTIN, and "Bill to" on the receipt',
      big?.answer === 'APPLIED' && oN4.buyerName === 'Kavya R' && oN4.buyerGstin === null && oN4.buyerAddress === '9 Lake View\nChennai 600001' && rN4?.buyer?.gstin === null && rN4?.buyer?.address === '9 Lake View\nChennai 600001',
      `${big?.answer} ${JSON.stringify(oN4)} ${JSON.stringify(rN4?.buyer)}`);

    console.log('\nR. PAYMENT REFERENCES FROM THE TILL');
    const rf1: any = await applySale(CLIENT, store.id, { ...bill('RF1', 1, [{ method: 'UPI', amountPaise: 200000, reference: '791382170059' }, { method: 'CARD', amountPaise: 100000, reference: '4321/C60780' }]), customer: null } as any);
    const rfRows = await prisma.salesOrderPayment.findMany({ where: { clientId: CLIENT, kind: 'PAYMENT', salesOrder: { externalOrderId: `INV/HOLD/${STAMP}-RF1` } }, select: { method: true, reference: true } });
    check('the UTR and the card approval code are stored on their payment rows', rf1?.answer === 'APPLIED' && rfRows.some(r => r.method === 'UPI' && r.reference === '791382170059') && rfRows.some(r => r.method === 'CARD' && r.reference === '4321/C60780'), `${rf1?.answer} ${JSON.stringify(rfRows)}`);
    const rf2: any = await applySale(CLIENT, store.id, { ...bill('RF2', 1, [{ method: 'CARD', amountPaise: PRICE, reference: '4111 1111 1111 1111' }]), customer: null } as any);
    const rf2Row = await prisma.salesOrderPayment.findFirst({ where: { clientId: CLIENT, kind: 'PAYMENT', salesOrder: { externalOrderId: `INV/HOLD/${STAMP}-RF2` } }, select: { reference: true } });
    check('a "reference" that looks like a whole card number is never stored -- the bill still applies, with a warning', rf2?.answer === 'APPLIED' && rf2Row?.reference === null && (rf2?.warnings ?? []).some((w: string) => /reference was not kept/.test(w)), `${rf2?.answer} ${JSON.stringify(rf2?.warnings)} ${JSON.stringify(rf2Row)}`);

    console.log('\nU. UDHAAR: POINTS AS THE MONEY COMES IN');
    const earnedOn = async (id: string) => (await entries(id)).filter(e => e.kind === 'EARNED').reduce((a, e) => a + e.points, 0);
    const u1: any = await applySale(CLIENT, store.id, bill('U1', 1, [{ method: 'CASH', amountPaise: 70000 }]) as any);
    const oU = await orderOf('U1');
    check('a ₹3,000 credit bill with ₹700 paid earns on the ₹700 only (7), not on the ₹2,300 still owed', u1?.answer === 'APPLIED' && await earnedOn(oU.id) === 7, `${u1?.answer} ${JSON.stringify(await entries(oU.id))}`);
    const sU0 = await statusOf('U1');
    check('  ...the bill status says earned 7 at sale (the till stores this on the bill)', sU0?.points?.earned === 7, JSON.stringify(sU0?.points));
    const billPoints = async () => (await A.get('/events/status', { params: { invoiceNo: `INV/HOLD/${STAMP}-U1` } })).data?.data?.points;
    const collect = (key: string, paise: number) => applyPaymentUpdate(CLIENT, store.id, { invoiceNo: `INV/HOLD/${STAMP}-U1`, idempotencyKey: `${key}-${STAMP}`, payments: [{ method: 'UPI', amountPaise: paise, reference: '791453570041' }] });
    const p1: any = await collect('u1a', 115000);
    check('  ...₹1,150 collected: now ₹1,850 paid in all, 18 earned (11 added)', p1?.answer === 'APPLIED' && await earnedOn(oU.id) === 18, `${p1?.answer} ${p1?.detail ?? ''} ${JSON.stringify(await entries(oU.id))}`);
    const p1again: any = await collect('u1a', 115000);
    check('  ...the same collection sent again adds no money and no points', p1again?.answer === 'ALREADY_APPLIED' && await earnedOn(oU.id) === 18, `${p1again?.answer} ${JSON.stringify(await entries(oU.id))}`);
    const p2: any = await collect('u1b', 115000);
    const rU: any = await counterSaleService.getSale(CLIENT, oU.id);
    check('  ...the rest collected: paid in full, 30 earned in all -- the same as paying ₹3,000 at once', p2?.answer === 'APPLIED' && rU?.payment?.due === 0 && await earnedOn(oU.id) === 30, `${p2?.answer} due=${rU?.payment?.due} ${JSON.stringify(await entries(oU.id))}`);
    const latest = await prisma.loyaltyEntry.findFirst({ where: { salesOrderId: oU.id }, orderBy: { createdAt: 'desc' }, select: { balance: true } });
    const sU2 = await billPoints();
    check('  ...and the bill status now says earned 30, balance after = the latest entry (what the till re-reads after a collection)', sU2?.earned === 30 && sU2?.used === 0 && sU2?.balanceAfter === latest?.balance && latest?.balance === await pointsOf(), `${JSON.stringify(sU2)} latest=${latest?.balance} held=${await pointsOf()}`);
    const u2: any = await applySale(CLIENT, store.id, { ...bill('U2', 1, [{ method: 'CASH', amountPaise: 70000 }]), customer: null } as any);
    const p3: any = await applyPaymentUpdate(CLIENT, store.id, { invoiceNo: `INV/HOLD/${STAMP}-U2`, idempotencyKey: `u2-${STAMP}`, payments: [{ method: 'CASH', amountPaise: 230000 }] });
    check('  ...a walk-in credit bill earns nothing, at sale or at collection', u2?.answer === 'APPLIED' && p3?.answer === 'APPLIED' && (await entries((await orderOf('U2')).id)).length === 0, `${u2?.answer} ${p3?.answer} ${JSON.stringify(await entries((await orderOf('U2')).id))}`);

    console.log('\nTHE BOOKS BALANCE');
    const sumP = (await prisma.loyaltyEntry.aggregate({ where: { customerId: cust.id }, _sum: { points: true } }))._sum.points ?? 0;
    const sumC = (await prisma.storeCreditEntry.aggregate({ where: { customerId: cust.id }, _sum: { amountPaise: true } }))._sum.amountPaise ?? 0;
    check('points held equal the sum of entries; credit held equals the sum of entries', sumP === await pointsOf() && sumC === await creditOf(), `${sumP}/${await pointsOf()} ${sumC}/${await creditOf()}`);
  } finally {
    await teardown();
  }
  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => { console.log('CRASHED:', e?.stack ?? e); await teardown().catch(() => undefined); await prisma.$disconnect(); process.exit(1); });
