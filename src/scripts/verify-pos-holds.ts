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
 *
 *   npx tsx src/scripts/verify-pos-holds.ts     (needs the local backend on :4006)
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { POS_BASE_URL } from '../utils/posConnection';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { applySale } from '../services/pos/pos-events.service';
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
    ['orders', () => prisma.salesOrder.deleteMany({ where: w })],
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
