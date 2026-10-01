/**
 * The POS link, when things go wrong in the ways a real shop makes them go wrong.
 *
 * verify-pos-endpoints proves every event kind and every refusal one at a time. This is the other
 * question: what happens when two true things collide.
 *
 *   A. two tills at one store sell the LAST piece in the same instant
 *   B. the owner replaces a till's key while a bill is still waiting to be applied
 *   C. the store is switched off while its till is still connected
 *   D. a product is deleted after it was sold at the till, and then comes back as a return
 *   E. a customer returns more than they bought, across two part returns
 *   F. the same payment is sent twice with a different amount
 *   G. somebody without the permission tries to manage tills
 *
 * A to F run on a throwaway shop made here and removed at the end. G needs a person who can sign
 * in, so it uses the shared test shop and removes the cashier it adds.
 *
 * HOW A AND C ARE RUN. On a development machine the POS queue worker is off, and a bill accepted by
 * the local API is applied by the PRODUCTION backend (one shared database). That is fine for B, D,
 * E and F, which test behaviour already live -- but A and C test the code in this checkout, so they
 * call applySale directly: the same function the worker calls, on the real database, with nothing
 * stood in for.
 *
 *   npx tsx src/scripts/verify-pos-bad-cases.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { productService } from '../services/product.service';
import { AuthService } from '../services/auth.service';
import { ensureTestTenant } from './support/testTenant';
import { applySale } from '../services/pos/pos-events.service';

const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const BASE = `${API}/pos/v1`;
const STAMP = Date.now();
const CLIENT = `pos-bad-${STAMP}`;
const PRICE = 300000; // paise

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

const api = (key: string) => axios.create({ baseURL: BASE, headers: { 'X-Storefront-Key': key }, validateStatus: () => true });
const numberOf = (body: any) => String(body.kind === 'payment.updated' ? body.idempotencyKey : (body.creditNoteNo ?? body.invoiceNo));

/** Wait for an accepted event to be applied or refused, asking with `askKey` (defaults to the sender's). */
async function outcome(askKey: string, body: any, ms = 240_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = await api(askKey).get(`/events/status?invoiceNo=${encodeURIComponent(numberOf(body))}`);
    const d = s.data?.data;
    if (d && (d.status === 'APPLIED' || d.status === 'REJECTED')) return d;
    await new Promise(res => setTimeout(res, 600));
  }
  throw new Error(`${numberOf(body)} never settled`);
}
async function send(key: string, body: any) {
  const r = await api(key).post('/events', body);
  if (r.data?.data?.answer !== 'ACCEPTED') return { http: r.status, ...(r.data?.data ?? {}) };
  return { http: r.status, ...(await outcome(key, body)) };
}
const sale = (invoiceNo: string, code: string, qty: number, paidPaise = PRICE * qty) => ({
  kind: 'sale.completed', invoiceNo, occurredAt: new Date().toISOString(),
  lines: [{ itemCode: code, qty, unitPricePaise: PRICE, lineTotalPaise: PRICE * qty }],
  totals: {}, payments: [{ method: 'CASH', amountPaise: paidPaise }]
});
const ret = (creditNoteNo: string, againstInvoiceNo: string, code: string, qty: number) => ({
  kind: 'sale.returned', creditNoteNo, againstInvoiceNo,
  lines: [{ itemCode: code, qty, lineTotalPaise: PRICE * qty }], totals: {}, refund: { method: 'CASH' }
});

async function teardown() {
  const w = { clientId: CLIENT };
  const steps: [string, () => Promise<unknown>][] = [
    ['pos events', () => prisma.posInboundEvent.deleteMany({ where: w })],
    ['payments', () => prisma.salesOrderPayment.deleteMany({ where: w })],
    ['return items', () => prisma.salesReturnItem.deleteMany({ where: { salesReturn: w } })],
    ['returns', () => prisma.salesReturn.deleteMany({ where: w })],
    ['orders', () => prisma.salesOrder.deleteMany({ where: w })],
    ['transactions', () => prisma.inventoryTransaction.deleteMany({ where: w })],
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
  console.log(`\nPOS bad cases, on ${CLIENT}\n`);
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Counter', code: `BAD-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.clientSettings.upsert({
    where: { clientId: CLIENT },
    create: { clientId: CLIENT, gstRegistration: 'REGULAR', gstNumber: '36AABCU9603R1ZX', gstStateCode: '36' },
    update: {}
  });

  const mk = async (n: number, title: string, qty: number) => {
    const product = await prisma.product.create({ data: {
      clientId: CLIENT, productCode: `BADP-${STAMP}-${n}`, slug: `bad-${STAMP}-${n}`, title,
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', fabric: 'Cotton',
      basePrice: 3000, status: 'ACTIVE' as any, publishedAt: new Date(),
      hsnCode: '5208', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
    } });
    const variant = await prisma.productVariant.create({ data: {
      productId: product.id, clientId: CLIENT, colorName: 'Indigo', size: 'Free Size',
      variantCode: `BADV-${STAMP}-${n}`, sku: `BADS-${STAMP}-${n}`, sellingPrice: 3000
    } });
    if (qty) await inventoryMutationService.applyMovement({
      clientId: CLIENT, variantId: variant.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE',
      quantityDelta: qty, unitCost: 1200, notes: 'verify-pos-bad-cases setup', createdBy: 'verify-pos-bad-cases'
    });
    return { product, variant };
  };
  const shelf = async (variantId: string) => (await prisma.inventoryStock.findFirst({ where: { clientId: CLIENT, variantId, locationId: store.id }, select: { quantity: true } }))?.quantity ?? 0;
  const history = async (variantId: string) => Number((await prisma.inventoryTransaction.aggregate({ where: { clientId: CLIENT, variantId, locationId: store.id }, _sum: { quantity: true } }))._sum.quantity ?? 0);

  const till = async (name: string) => posConnectionService.create(CLIENT, { locationId: store.id, name });
  const t1 = await till('Counter 1');
  const t2 = await till('Counter 2');

  try {
    // ── A ────────────────────────────────────────────────────────────────────────────────────
    console.log('A. TWO TILLS SELL THE LAST PIECE AT THE SAME MOMENT');
    const last = await mk(1, 'The last piece', 1);
    const [a1, a2]: any[] = await Promise.all([
      applySale(CLIENT, store.id, sale(`INV/BAD/${STAMP}-A1`, last.variant.variantCode, 1) as any),
      applySale(CLIENT, store.id, sale(`INV/BAD/${STAMP}-A2`, last.variant.variantCode, 1) as any)
    ]);
    check('both bills are recorded: each customer walked out with a paid bill', a1.answer === 'APPLIED' && a2.answer === 'APPLIED', `${a1.answer} / ${a2.answer}`);
    const aOrders = await prisma.salesOrder.count({ where: { clientId: CLIENT, externalOrderId: { startsWith: `INV/BAD/${STAMP}-A` } } });
    check('as two orders, not one and not three', aOrders === 2, String(aOrders));
    check('the shelf says so honestly: one short', await shelf(last.variant.id) === -1, String(await shelf(last.variant.id)));
    check('and the stock history adds up to the shelf', await history(last.variant.id) === await shelf(last.variant.id), `history ${await history(last.variant.id)}`);
    const aWarn = [...(a1.warnings ?? []), ...(a2.warnings ?? [])];
    check('the owner is told a piece was sold that was not there', aWarn.some(w => /sold 1 more than Inventory had/.test(w) && /stock is now -1/.test(w)), JSON.stringify(aWarn).slice(0, 220));
    check('told once, by the bill that took it below zero, not by both', aWarn.filter(w => /more than Inventory had/.test(w)).length === 1, String(aWarn.length));

    // ── B ────────────────────────────────────────────────────────────────────────────────────
    console.log('\nB. THE KEY IS REPLACED WHILE A BILL IS STILL WAITING');
    const b = await mk(2, 'Mid-day saree', 10);
    const bBill = sale(`INV/BAD/${STAMP}-B1`, b.variant.variantCode, 2);
    const accepted = await api(t1.key).post('/events', bBill);
    check('the bill is taken in', ['ACCEPTED', 'APPLIED'].includes(accepted.data?.data?.answer), JSON.stringify(accepted.data?.data?.answer));
    const fresh = await posConnectionService.replaceKey(CLIENT, t1.id);
    check('the old key stops at once, even for asking about its own bill', (await api(t1.key).get(`/events/status?invoiceNo=${encodeURIComponent(bBill.invoiceNo)}`)).status === 401);
    const bDone = await outcome(fresh.key, bBill);
    check('the bill sent under the old key is still applied', bDone.answer === 'APPLIED' || bDone.answer === 'ALREADY_APPLIED', bDone.answer);
    check('and found with the NEW key', Boolean(bDone.orderNumber), String(bDone.orderNumber));
    check('stock moved once, by what was sold', await shelf(b.variant.id) === 8, String(await shelf(b.variant.id)));
    const bAgain = await send(fresh.key, bBill);
    check('resending it under the new key is ALREADY_APPLIED, and nothing moves', bAgain.answer === 'ALREADY_APPLIED' && await shelf(b.variant.id) === 8, `${bAgain.answer}, shelf ${await shelf(b.variant.id)}`);
    t1.key = fresh.key;

    // ── E (before the store is switched off) ─────────────────────────────────────────────────
    console.log('\nE. RETURNING MORE THAN WAS BOUGHT, ACROSS TWO PART RETURNS');
    const eInv = `INV/BAD/${STAMP}-E1`;
    const e = await mk(5, 'Pair of sarees', 10);
    check('two pieces sold', (await send(t1.key, sale(eInv, e.variant.variantCode, 2))).answer === 'APPLIED');
    const e1 = await send(t1.key, ret(`CN/BAD/${STAMP}-E1`, eInv, e.variant.variantCode, 1));
    check('one comes back: applied', e1.answer === 'APPLIED', e1.answer);
    const e2 = await send(t1.key, ret(`CN/BAD/${STAMP}-E2`, eInv, e.variant.variantCode, 2));
    check('two more against the same bill: refused, only one is left to return', e2.answer === 'QTY_EXCEEDS_SOLD', `${e2.answer}: ${e2.detail ?? ''}`.slice(0, 150));
    const e3 = await send(t1.key, ret(`CN/BAD/${STAMP}-E3`, eInv, e.variant.variantCode, 1));
    check('the one that IS left comes back: applied', e3.answer === 'APPLIED', e3.answer);
    const e4 = await send(t1.key, ret(`CN/BAD/${STAMP}-E4`, eInv, e.variant.variantCode, 1));
    check('a third piece of a two-piece bill: refused', e4.answer === 'QTY_EXCEEDS_SOLD', e4.answer);
    check('the shelf is back to where it started, not above it', await shelf(e.variant.id) === 10, String(await shelf(e.variant.id)));
    const eRefunds = await prisma.salesOrderPayment.aggregate({ where: { clientId: CLIENT, kind: 'REFUND', salesOrder: { externalOrderId: eInv } }, _sum: { amount: true } });
    check('and exactly what was paid has been refunded, no more', Number(eRefunds._sum.amount ?? 0) === 6000, String(eRefunds._sum.amount));

    // ── F ────────────────────────────────────────────────────────────────────────────────────
    console.log('\nF. THE SAME PAYMENT SENT TWICE, WITH A DIFFERENT AMOUNT');
    const fInv = `INV/BAD/${STAMP}-F1`;
    const f = await mk(6, 'Kept saree', 5);
    check('a kept bill: 3,000 of goods, 1,000 paid', (await send(t1.key, sale(fInv, f.variant.variantCode, 1, 100000))).answer === 'APPLIED');
    const payKey = `${fInv}:pay:1`;
    const pay = (amountPaise: number) => ({ kind: 'payment.updated', invoiceNo: fInv, idempotencyKey: payKey, occurredAt: new Date().toISOString(), payments: [{ method: 'UPI', amountPaise, reference: 'utr-bad-1' }] });
    const f1 = await send(t1.key, pay(100000));
    check('1,000 more arrives: applied', f1.answer === 'APPLIED', f1.answer);
    const f2 = await send(t1.key, pay(50000));
    check('the same payment key with 500: ALREADY_APPLIED, not a second payment', f2.answer === 'ALREADY_APPLIED', f2.answer);
    const paid = await prisma.salesOrderPayment.findMany({ where: { clientId: CLIENT, kind: 'PAYMENT', salesOrder: { externalOrderId: fInv } }, select: { amount: true } });
    const paidTotal = paid.reduce((s, r) => s + Number(r.amount), 0);
    check('the books hold 2,000 paid: neither 2,500 nor the first amount overwritten', paidTotal === 2000 && paid.length === 2, paid.map(r => String(r.amount)).join(' + '));
    const f3 = await send(t1.key, { ...pay(100000), idempotencyKey: `${fInv}:pay:2` });
    check('the last 1,000 under its own key: applied, and the bill is settled', f3.answer === 'APPLIED', f3.answer);

    // ── D ────────────────────────────────────────────────────────────────────────────────────
    console.log('\nD. A PRODUCT IS DELETED AFTER IT WAS SOLD, THEN COMES BACK');
    const dInv = `INV/BAD/${STAMP}-D1`;
    const d = await mk(4, 'Soon-deleted saree', 5);
    check('sold while it existed', (await send(t1.key, sale(dInv, d.variant.variantCode, 1))).answer === 'APPLIED');
    await productService.trashProduct(d.product.id, CLIENT);
    const cat = await api(t1.key).get('/catalogue?limit=200');
    const listed = (cat.data?.data?.products ?? []).some((p: any) => (p.variants ?? []).some((v: any) => v.variantCode === d.variant.variantCode || v.itemCode === d.variant.variantCode));
    check('the till is no longer offered it', cat.status === 200 && !listed);
    const dBack = await send(t1.key, ret(`CN/BAD/${STAMP}-D1`, dInv, d.variant.variantCode, 1));
    check('the customer can still return it: the bill was real', dBack.answer === 'APPLIED', `${dBack.answer}: ${dBack.detail ?? ''}`.slice(0, 160));
    check('and the piece is back on the shelf', await shelf(d.variant.id) === 5, String(await shelf(d.variant.id)));
    // A till that has not refreshed still sells it. Applied directly, like A and C: this is the
    // code in this checkout, not what production is running.
    const dAgain: any = await applySale(CLIENT, store.id, sale(`INV/BAD/${STAMP}-D2`, d.variant.variantCode, 1) as any);
    check('a NEW sale of the deleted product is recorded: the piece left the shop', dAgain.answer === 'APPLIED', `${dAgain.answer}: ${dAgain.detail ?? ''}`.slice(0, 160));
    check('and the owner is told the till sold something deleted here', (dAgain.warnings ?? []).some((w: string) => /has been deleted in Inventory/.test(w) && /Refresh the items on the till/.test(w)), JSON.stringify(dAgain.warnings ?? []).slice(0, 220));
    check('its stock came off like any other sale', await shelf(d.variant.id) === 4, String(await shelf(d.variant.id)));

    // ── C ────────────────────────────────────────────────────────────────────────────────────
    console.log('\nC. THE STORE IS SWITCHED OFF WHILE ITS TILL IS CONNECTED');
    const c = await mk(3, 'Switched-off-store saree', 5);
    await prisma.stockLocation.update({ where: { id: store.id }, data: { active: false } });
    const cSale: any = await applySale(CLIENT, store.id, sale(`INV/BAD/${STAMP}-C1`, c.variant.variantCode, 1) as any);
    check('a bill the till already made is still recorded, not lost', cSale.answer === 'APPLIED', `${cSale.answer}: ${cSale.detail ?? ''}`.slice(0, 160));
    check('and its stock came off', await shelf(c.variant.id) === 4, String(await shelf(c.variant.id)));
    check('with a warning the owner can act on', (cSale.warnings ?? []).some((w: string) => /switched off in Inventory/.test(w) && /disconnect the till/.test(w)), JSON.stringify(cSale.warnings ?? []).slice(0, 200));
    // What Inventory itself may NOT do at a closed store is unchanged: only a sale that already happened is let in.
    const typed = await prisma.salesOrder.count({ where: { clientId: CLIENT, externalOrderId: `INV/BAD/${STAMP}-C1` } });
    check('recorded as exactly one order', typed === 1, String(typed));
    let refusedNew = '';
    try { await posConnectionService.create(CLIENT, { locationId: store.id, name: 'Too late' }); } catch (err: any) { refusedNew = err.message; }
    check('a NEW till cannot be connected to a switched-off store', /switched off/i.test(refusedNew), refusedNew);
    let cannotDelete = false;
    try { await prisma.stockLocation.delete({ where: { id: store.id } }); } catch { cannotDelete = true; }
    check('a store with bills and stock history cannot be deleted from under its till', cannotDelete);
    await prisma.stockLocation.update({ where: { id: store.id }, data: { active: true } });
  } finally {
    await teardown();
  }

  // ── G ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\nG. SOMEBODY WITHOUT THE PERMISSION');
  const t = await ensureTestTenant();
  const role = await prisma.role.findFirst({ where: { clientId: t.clientId, name: 'SALES' }, select: { id: true } });
  const email = `verify-cashier-${STAMP}@example.test`;
  const password = `Cashier-${STAMP}-x9`;
  const cashier = await prisma.user.create({ data: { clientId: t.clientId, name: 'Verification Cashier', email, password: await AuthService.hashPassword(password), status: 'ACTIVE' } });
  try {
    if (!role) throw new Error('the test shop has no SALES role');
    await prisma.userRole.create({ data: { userId: cashier.id, roleId: role.id } });
    const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const cookie = ((login.headers as any).getSetCookie?.() ?? []).map((x: string) => x.split(';')[0]).join('; ');
    check('a sales person can sign in', login.status === 200 && cookie.length > 0, String(login.status));
    const as = (path: string, method = 'GET', body?: any) => fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }).then(r => r.status);
    const loc = await prisma.stockLocation.findFirst({ where: { clientId: t.clientId, active: true }, select: { id: true } });
    check('they cannot list the shop\'s tills', await as('/pos-connections') === 403);
    check('they cannot make a till key', await as('/pos-connections', 'POST', { locationId: loc!.id }) === 403);
    check('they cannot replace or disconnect one', await as('/pos-connections/00000000-0000-0000-0000-000000000000/replace-key', 'POST') === 403 && await as('/pos-connections/00000000-0000-0000-0000-000000000000/disconnect', 'POST') === 403);
    check('they CAN ask which stores bill at a till (their screen needs it to hide New sale)', await as('/pos-connections/billing-locations') === 200);
    check('and no till was made by any of that', (await prisma.storefrontConnection.count({ where: { clientId: t.clientId, baseUrl: POS_BASE_URL, status: 'ACTIVE' } })) === 0);
  } finally {
    await prisma.userRole.deleteMany({ where: { userId: cashier.id } });
    await prisma.user.delete({ where: { id: cashier.id } }).catch(() => undefined);
  }

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => { console.log('CRASHED:', e?.stack ?? e); await teardown().catch(() => undefined); await prisma.$disconnect(); process.exit(1); });
