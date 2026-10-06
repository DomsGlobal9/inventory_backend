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
 *   H. the owner leaves a bill out of Inventory at the till (document.skipped)
 *   I. a return or exchange arrives while its own sale is still being applied
 *
 * A to F, H and I run on a throwaway shop made here and removed at the end. H goes through the real
 * route: a left-out bill is recorded in the route itself, no worker involved, so it tests this checkout. G needs a person who can sign
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
import { offerService } from '../services/offers';

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
const numberOf = (body: any) => String(
  body.kind === 'payment.updated' ? body.idempotencyKey
    : body.kind === 'sale.exchanged' ? body.exchangeNo
      : (body.creditNoteNo ?? body.invoiceNo));

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
    ['quotes', () => prisma.pricingQuote.deleteMany({ where: w })],
    ['redemptions', () => prisma.offerRedemption.deleteMany({ where: w })],
    ['offer versions', () => prisma.offerVersion.deleteMany({ where: { offer: w } })],
    ['offers', () => prisma.offer.deleteMany({ where: w })],
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

    // ── I ────────────────────────────────────────────────────────────────────────────────────
    console.log('\nI. A RETURN OR EXCHANGE ARRIVES WHILE ITS SALE IS STILL BEING APPLIED');
    /*
     * Made certain instead of hoped for: a sale row held RUNNING with a fresh heartbeat and no order
     * yet. No worker claims a RUNNING row, and recovery leaves one alone for five minutes, so the
     * window that only opens under load in verify-pos-endpoints L is simply open here. Its payload
     * names an item that does not exist, so even if something did pick it up it would be refused.
     */
    const iItem = await mk(8, 'Swap saree', 5);
    const iInv = `INV/BAD/${STAMP}-I1`;
    const planted = await prisma.posInboundEvent.create({ data: {
      clientId: CLIENT, locationId: store.id, kind: 'sale.completed', invoiceNo: iInv,
      payload: sale(iInv, 'NO-SUCH-ITEM', 1), status: 'RUNNING', heartbeatAt: new Date(), attempts: 1
    } });
    const swap = (exchangeNo: string) => ({
      kind: 'sale.exchanged', exchangeNo, againstInvoiceNo: iInv, occurredAt: new Date().toISOString(),
      returned: [{ itemCode: iItem.variant.variantCode, qty: 1, lineTotalPaise: PRICE }],
      sold: [{ itemCode: iItem.variant.variantCode, qty: 1, unitPricePaise: PRICE, lineTotalPaise: PRICE }],
      payments: []
    });
    try {
      const iRet = await api(t1.key).post('/events', ret(`CN/BAD/${STAMP}-I1`, iInv, iItem.variant.variantCode, 1));
      check('a return against it: 409 "not applied yet", never UNKNOWN_ORDER', iRet.status === 409 && iRet.data?.data?.answer === 'SALE_NOT_YET_APPLIED', `${iRet.status} ${iRet.data?.data?.answer}`);
      const iEx = await api(t1.key).post('/events', swap(`INV/BAD/${STAMP}-I2`));
      check('an exchange against it: 409 "not applied yet", so the till sends it again', iEx.status === 409 && iEx.data?.data?.answer === 'SALE_NOT_YET_APPLIED' && /exchange again/.test(iEx.data?.data?.detail ?? ''), `${iEx.status} ${iEx.data?.data?.answer}`);
      check('and that early exchange was not queued, so it cannot be rejected for good', await prisma.posInboundEvent.count({ where: { clientId: CLIENT, kind: 'sale.exchanged', invoiceNo: `INV/BAD/${STAMP}-I2` } }) === 0);
    } finally {
      await prisma.posInboundEvent.delete({ where: { id: planted.id } });
    }
    const iUnknown = await send(t1.key, swap(`INV/BAD/${STAMP}-I3`));
    check('an exchange against a bill that never existed is still refused, as before', iUnknown.answer === 'UNKNOWN_ORDER', `${iUnknown.answer}: ${iUnknown.detail ?? ''}`.slice(0, 160));

    // ── H ────────────────────────────────────────────────────────────────────────────────────
    console.log('\nH. THE OWNER LEAVES A BILL OUT OF INVENTORY AT THE TILL');
    const h = await mk(7, 'Left-out saree', 5);
    const hInv = `INV/BAD/${STAMP}-H1`;
    const skip = (over: any = {}) => ({
      kind: 'document.skipped', document: hInv, eventType: 'sale.completed',
      reason: 'The item was deleted in Inventory for good', skippedBy: 'Owner', skippedAt: new Date().toISOString(), ...over
    });
    const lastBefore = (await posConnectionService.list(CLIENT))[0]?.lastBillAt;
    const hShort = await api(t1.key).post('/events', skip({ reason: 'gone' }));
    check('a reason shorter than a sentence is refused', hShort.status === 422 && hShort.data?.data?.answer === 'BAD_PAYLOAD', `${hShort.status} ${hShort.data?.data?.detail}`);
    const hKind = await api(t1.key).post('/events', skip({ eventType: 'sale.vanished' }));
    check('a kind of bill the till never sends is refused', hKind.status === 422 && hKind.data?.data?.answer === 'BAD_PAYLOAD', `${hKind.status}`);
    const h1 = await api(t1.key).post('/events', skip());
    check('the left-out bill is noted at once: 200 APPLIED, not queued', h1.status === 200 && h1.data?.data?.answer === 'APPLIED', `${h1.status} ${h1.data?.data?.answer}`);
    const h2 = await api(t1.key).post('/events', skip());
    check('sent again: 200 ALREADY_APPLIED', h2.status === 200 && h2.data?.data?.answer === 'ALREADY_APPLIED', `${h2.status} ${h2.data?.data?.answer}`);
    check('noted once, not twice', await prisma.posInboundEvent.count({ where: { clientId: CLIENT, kind: 'document.skipped', invoiceNo: hInv } }) === 1);
    check('no stock moved: it was left out because it could not be applied', await shelf(h.variant.id) === 5, String(await shelf(h.variant.id)));
    check('no order was made from it', await prisma.salesOrder.count({ where: { clientId: CLIENT, externalOrderId: hInv } }) === 0);
    const hStatus = await api(t1.key).get(`/events/status?invoiceNo=${encodeURIComponent(hInv)}`);
    check('asking where that bill got to says Inventory has no such bill (404), not APPLIED', hStatus.status === 404, `${hStatus.status} ${hStatus.data?.data?.answer}`);
    check('a left-out bill is not "the last bill received"', String((await posConnectionService.list(CLIENT))[0]?.lastBillAt) === String(lastBefore), String(lastBefore));
    const seen = await posConnectionService.leftOut(CLIENT);
    check('the owner sees it, with the store and the reason', seen.length === 1 && seen[0].document === hInv && seen[0].locationName === 'Counter' && /deleted in Inventory/.test(seen[0].reason ?? ''), JSON.stringify(seen[0] ?? null).slice(0, 200));
    await posConnectionService.disconnect(CLIENT, t1.id);
    await posConnectionService.disconnect(CLIENT, t2.id);
    check('and still sees it after every till is disconnected: the books are still short', (await posConnectionService.leftOut(CLIENT)).length === 1);

    // ── J ────────────────────────────────────────────────
    console.log('\nJ. DISCOUNTED LINES FROM THE TILL (what the till charged is the bill)');
    const j = await mk(9, 'Discounted saree', 20);
    const jSale = (n: string, line: any) => ({
      kind: 'sale.completed', invoiceNo: `INV/BAD/${STAMP}-${n}`, occurredAt: new Date().toISOString(),
      lines: [{ itemCode: j.variant.variantCode, ...line }], totals: {}, payments: [{ method: 'CASH', amountPaise: line.lineTotalPaise }]
    });
    const jLine = async (n: string) => {
      const o = await prisma.salesOrder.findFirst({ where: { clientId: CLIENT, externalOrderId: `INV/BAD/${STAMP}-${n}` }, include: { items: true } });
      const it = o?.items[0];
      return it ? { total: Math.round(Number(it.totalPrice) * 100), discount: Math.round(Number(it.lineDiscount) * 100), list: Math.round(Number(it.listUnitPrice) * 100) } : null;
    };
    const j1: any = await applySale(CLIENT, store.id, jSale('J1', { qty: 3, unitPricePaise: PRICE, discountPaise: 10000, lineTotalPaise: PRICE * 3 - 10000 }) as any);
    const l1 = await jLine('J1');
    check('3 x Rs 3000 less Rs 100 (Rs 8,900 does not split evenly into 3): applied, charged exactly Rs 8,900, Rs 100 off',
      j1?.answer === 'APPLIED' && l1?.total === PRICE * 3 - 10000 && l1?.discount === 10000 && l1?.list === PRICE, `${j1?.answer} ${j1?.detail ?? ''} ${JSON.stringify(l1)}`);
    const j2: any = await applySale(CLIENT, store.id, jSale('J2', { qty: 2, discountPaise: 20000, lineTotalPaise: PRICE * 2 - 20000 }) as any);
    const l2 = await jLine('J2');
    check('a discount sent without the list price: applied, Rs 200 off once, not twice',
      j2?.answer === 'APPLIED' && l2?.total === PRICE * 2 - 20000 && l2?.discount === 20000, `${j2?.answer} ${j2?.detail ?? ''} ${JSON.stringify(l2)}`);
    const j3: any = await applySale(CLIENT, store.id, jSale('J3', { qty: 3, lineTotalPaise: 899900 }) as any);
    const l3 = await jLine('J3');
    check('3 pieces for Rs 8,999 with no discount declared: the line is exactly Rs 8,999, not a paisa more',
      j3?.answer === 'APPLIED' && l3?.total === 899900, `${j3?.answer} ${j3?.detail ?? ''} ${JSON.stringify(l3)}`);
    const j4: any = await applySale(CLIENT, store.id, jSale('J4', { qty: 3, unitPricePaise: PRICE, discountPaise: 10000, lineTotalPaise: PRICE * 3 - 20000 }) as any);
    const l4 = await jLine('J4');
    check('the till\'s numbers disagree (Rs 100 off said, Rs 200 less charged): applied at what was charged, with a warning',
      j4?.answer === 'APPLIED' && l4?.total === PRICE * 3 - 20000 && (j4?.warnings ?? []).some((w: string) => /discount/i.test(w)), `${j4?.answer} ${JSON.stringify(j4?.warnings)} ${JSON.stringify(l4)}`);
    check('every one of those took its pieces off the shelf: 20 - 3 - 2 - 3 - 3 = 9', await shelf(j.variant.id) === 9, String(await shelf(j.variant.id)));
    const kindJ = await prisma.salesOrder.findFirst({ where: { clientId: CLIENT, externalOrderId: `INV/BAD/${STAMP}-J1` }, select: { documentKind: true } });
    check('a till bill in a GST-registered shop is recorded as a TAX_INVOICE, its kind fixed at sale time', kindJ?.documentKind === 'TAX_INVOICE', String(kindJ?.documentKind));

    { // ── K ── (its own block: J above already named l1 and l3)
    console.log('\nK. THE TILL ASKS FOR THE PRICE AFTER OFFERS (contract §9)');
    const t3 = await till('Quote till');
    const kA = await mk(10, 'Offer saree', 60);
    const kB = await mk(11, 'Second saree', 60);
    const A = kA.variant.variantCode, B = kB.variant.variantCode;
    const live = { startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 30 * 86400_000) };
    const offer = async (input: any) => {
      const o: any = await offerService.create(CLIENT, { level: 'LINE', valueType: 'PERCENTAGE', scope: 'ALL', ...live, ...input } as any);
      if (o.status !== 'ACTIVE') await offerService.setStatus(CLIENT, o.id, 'ACTIVE');
      return o;
    };
    const usage = async (id: string) => (await prisma.offer.findUniqueOrThrow({ where: { id }, select: { usageCount: true } })).usageCount;
    const auto = await offer({ name: 'Ten percent off', trigger: 'AUTOMATIC', value: 10 });
    const quote = (lines: any[], extra: any = {}) => api(t3.key).post('/quote', { lines, ...extra });

    const k1 = await quote([{ itemCode: A, qty: 2 }]);
    const l1 = k1.data?.data?.lines?.[0];
    check('2 x Rs 3000 with 10% off: list 3000, Rs 600 off, line Rs 5,400, the offer named', k1.status === 200 && l1?.listUnitPaise === PRICE && l1?.discountPaise === 60000 && l1?.lineTotalPaise === 540000 && l1?.offers?.[0]?.offerId === auto.id && l1?.offers?.[0]?.name === 'Ten percent off' && k1.data.data.totalPaise === 540000, `${k1.status} ${JSON.stringify(k1.data).slice(0, 300)}`);
    const until = Date.parse(k1.data?.data?.validUntil ?? '') - Date.now();
    check('  ...with a quoteId, good for about 15 minutes', typeof k1.data?.data?.quoteId === 'string' && until > 13 * 60_000 && until < 16 * 60_000, String(until));
    const k2 = await quote([{ itemCode: A, qty: 2 }]);
    check('the same basket again, unused: the SAME quoteId (no row per scan)', k2.data?.data?.quoteId === k1.data.data.quoteId, `${k2.data?.data?.quoteId} vs ${k1.data.data.quoteId}`);
    const k3 = await quote([{ itemCode: `NOPE-${STAMP}`, qty: 1 }, { itemCode: A, qty: 5 }]);
    const l3 = k3.data?.data?.lines ?? [];
    check('an item Inventory does not know: that line is unpriced, the other keeps its offer, the quote stands', k3.status === 200 && l3[0]?.unpriced === true && l3[1]?.discountPaise === 150000 && typeof k3.data.data.quoteId === 'string' && k3.data.data.totalPaise === 1350000, `${k3.status} ${JSON.stringify(l3).slice(0, 200)}`);
    const k4 = await quote([{ itemCode: A, qty: 1 }, { itemCode: A, qty: 1 }]);
    check('the same item on two lines is refused in words (422 BAD_PAYLOAD)', k4.status === 422 && k4.data?.data?.answer === 'BAD_PAYLOAD' && /once/.test(k4.data?.data?.detail ?? ''), `${k4.status} ${JSON.stringify(k4.data).slice(0, 150)}`);
    const k5 = await quote([]);
    const k5b = await quote(Array.from({ length: 101 }, (_, i) => ({ itemCode: `X${i}`, qty: 1 })));
    check('an empty basket, or more than 100 lines, is refused', k5.status === 422 && k5b.status === 422, `${k5.status} ${k5b.status}`);
    const k6 = await quote([{ itemCode: A, qty: 1 }], { couponCode: 'NOSUCH' });
    check('a code nobody made: the quote answers 200 and says the code is refused, in words', k6.status === 200 && k6.data?.data?.coupon?.accepted === false && /no offer with that code/i.test(k6.data?.data?.coupon?.reason ?? '') && k6.data.data.lines[0].discountPaise === 30000, JSON.stringify(k6.data?.data?.coupon));

    await offerService.setStatus(CLIENT, auto.id, 'PAUSED');
    const coded = await offer({ name: 'Flat two hundred off', trigger: 'CODE', couponCode: `TILL${STAMP}`, level: 'ORDER', valueType: 'FIXED_AMOUNT', value: 200 });
    const k7 = await quote([{ itemCode: A, qty: 1 }], { couponCode: `till${STAMP}` });
    const l7 = k7.data?.data?.lines?.[0];
    check('a real code, typed in small letters: accepted, Rs 200 off the line, the code offer named', k7.status === 200 && k7.data?.data?.coupon?.accepted === true && l7?.discountPaise === 20000 && l7?.lineTotalPaise === 280000 && l7?.offers?.[0]?.offerId === coded.id, `${k7.status} ${JSON.stringify(k7.data?.data).slice(0, 300)}`);

    const once = await offer({ name: 'Once each', trigger: 'AUTOMATIC', value: 5, usageLimitPerCustomer: 1 });
    const phone = `+919${String(STAMP).slice(-9)}`;
    await prisma.customer.create({ data: { clientId: CLIENT, customerCode: `QC-${STAMP}`, name: 'Quote Customer', phone, externalCustomerId: `POS:${phone}` } });
    const k8 = await quote([{ itemCode: A, qty: 6 }]);
    check('a walk-in (no customerRef): a once-per-customer offer is simply left out, never refused', k8.status === 200 && (k8.data?.data?.lines?.[0]?.offers ?? []).length === 0 && k8.data?.data?.lines?.[0]?.discountPaise === 0, JSON.stringify(k8.data?.data?.lines?.[0]));
    const k9 = await quote([{ itemCode: A, qty: 6 }], { customerRef: phone });
    check('the same basket with the customer named: the once-per-customer offer applies (Rs 900 off)', k9.status === 200 && k9.data?.data?.lines?.[0]?.offers?.[0]?.offerId === once.id && k9.data.data.lines[0].discountPaise === 90000, JSON.stringify(k9.data?.data?.lines?.[0]));
    const k10 = await quote([{ itemCode: A, qty: 7 }], { customerRef: '+919000000001' });
    check('a number Inventory has never seen: priced as a guest', (k10.data?.data?.lines?.[0]?.offers ?? []).length === 0, JSON.stringify(k10.data?.data?.lines?.[0]));
    check('  ...and those three are three different quotes', new Set([k8.data.data.quoteId, k9.data.data.quoteId, k10.data.data.quoteId]).size === 3);
    await offerService.setStatus(CLIENT, once.id, 'PAUSED');
    await offerService.setStatus(CLIENT, auto.id, 'ACTIVE');

    // ── L ────────────────────────────────────────────────
    console.log('\nL. A TILL BILL NAMES ITS QUOTE: OFFERS COUNTED PER LINE, NEVER REFUSED (contract §4.1)');
    const orderOf = async (inv: string) => prisma.salesOrder.findFirst({ where: { clientId: CLIENT, externalOrderId: inv }, select: { id: true, customerId: true } });
    const counted = async (inv: string) => { const o = await orderOf(inv); return o ? prisma.offerRedemption.findMany({ where: { salesOrderId: o.id, status: 'COUNTED' }, select: { offerId: true, amount: true } }) : []; };
    const discountRows = async (inv: string) => { const o = await orderOf(inv); return o ? prisma.salesOrderDiscount.findMany({ where: { salesOrderId: o.id }, select: { offerId: true, amount: true, source: true } }) : []; };
    const bill = (inv: string, quoteId: string | null, lines: any[], extra: any = {}) => ({
      kind: 'sale.completed', invoiceNo: `INV/BAD/${STAMP}-${inv}`, occurredAt: new Date().toISOString(), quoteId, lines, totals: {},
      payments: [{ method: 'CASH', amountPaise: lines.reduce((a: number, l: any) => a + l.lineTotalPaise, 0) }], ...extra
    });
    const quotedLine = (q: any, code: string) => { const l = q.data.data.lines.find((x: any) => x.itemCode === code); return { itemCode: code, qty: l.qty, unitPricePaise: l.listUnitPaise, discountPaise: l.discountPaise, lineTotalPaise: l.lineTotalPaise, offers: l.offers.map((o: any) => ({ offerId: o.offerId, discountPaise: o.discountPaise })) }; };

    const q1 = await quote([{ itemCode: A, qty: 2 }]);
    const s1: any = await applySale(CLIENT, store.id, bill('L1', q1.data.data.quoteId, [quotedLine(q1, A)]) as any);
    const c1 = await counted(`INV/BAD/${STAMP}-L1`);
    const d1 = await discountRows(`INV/BAD/${STAMP}-L1`);
    const o1 = await orderOf(`INV/BAD/${STAMP}-L1`);
    const quoteRow1 = await prisma.pricingQuote.findUnique({ where: { id: q1.data.data.quoteId } });
    check('a bill built from its quote: applied with no warnings, the offer COUNTED for Rs 600, a discount row written, the quote spent by this bill',
      s1?.answer === 'APPLIED' && !(s1?.warnings?.length) && c1.length === 1 && c1[0].offerId === auto.id && Number(c1[0].amount) === 600 && d1.length === 1 && d1[0].source === 'OFFER' && Number(d1[0].amount) === 600 && quoteRow1?.consumedAt != null && quoteRow1?.salesOrderId === o1?.id && await usage(auto.id) === 1,
      `${s1?.answer} ${JSON.stringify(s1?.warnings)} counted=${JSON.stringify(c1)} rows=${JSON.stringify(d1)} usage=${await usage(auto.id)}`);
    const q2 = await quote([{ itemCode: A, qty: 2 }]);
    check('the same basket for the NEXT customer gets a new quote, because the first is spent', q2.data?.data?.quoteId && q2.data.data.quoteId !== q1.data.data.quoteId, `${q2.data?.data?.quoteId} vs ${q1.data.data.quoteId}`);
    const s2: any = await applySale(CLIENT, store.id, bill('L2', q2.data.data.quoteId, [quotedLine(q2, A)]) as any);
    check('  ...and that bill is counted too (the second customer is not silently missed)', s2?.answer === 'APPLIED' && (await counted(`INV/BAD/${STAMP}-L2`)).length === 1 && await usage(auto.id) === 2, `${s2?.answer} usage=${await usage(auto.id)}`);
    const s3: any = await applySale(CLIENT, store.id, bill('L3', q1.data.data.quoteId, [quotedLine(q1, A)]) as any);
    check('a bill naming an already-spent quote: applied, nothing counted, a warning says why', s3?.answer === 'APPLIED' && (s3?.warnings ?? []).some((w: string) => /already used/.test(w)) && (await counted(`INV/BAD/${STAMP}-L3`)).length === 0 && await usage(auto.id) === 2, `${s3?.answer} ${JSON.stringify(s3?.warnings)}`);

    const q4 = await quote([{ itemCode: A, qty: 1 }, { itemCode: B, qty: 1 }]);
    const overridden = { itemCode: B, qty: 1, unitPricePaise: PRICE, discountPaise: 50000, lineTotalPaise: PRICE - 50000 };
    const s4: any = await applySale(CLIENT, store.id, bill('L4', q4.data.data.quoteId, [quotedLine(q4, A), overridden]) as any);
    const c4 = await counted(`INV/BAD/${STAMP}-L4`);
    check('the cashier overrode one line (sent with no offers): that line is not counted and says nothing; the other line IS counted (Rs 300)', s4?.answer === 'APPLIED' && !(s4?.warnings?.length) && c4.length === 1 && Number(c4[0].amount) === 300 && await usage(auto.id) === 3, `${s4?.answer} ${JSON.stringify(s4?.warnings)} ${JSON.stringify(c4)}`);
    const q4b = await quote([{ itemCode: A, qty: 1 }, { itemCode: B, qty: 1 }]);
    const tampered = { ...quotedLine(q4b, A), offers: [{ offerId: auto.id, discountPaise: 99999 }] };
    const s4b: any = await applySale(CLIENT, store.id, bill('L4B', q4b.data.data.quoteId, [tampered, quotedLine(q4b, B)]) as any);
    const c4b = await counted(`INV/BAD/${STAMP}-L4B`);
    check('a line whose offers differ from the quote: warned and not counted on that line; the other line still counts', s4b?.answer === 'APPLIED' && (s4b?.warnings ?? []).some((w: string) => /not the ones the quote gave/.test(w)) && c4b.length === 1 && Number(c4b[0].amount) === 300, `${s4b?.answer} ${JSON.stringify(s4b?.warnings)} ${JSON.stringify(c4b)}`);

    const s5: any = await applySale(CLIENT, store.id, bill('L5', '00000000-0000-4000-8000-000000000000', [{ ...quotedLine(q1, A), offers: [{ offerId: auto.id, discountPaise: 60000 }] }]) as any);
    check('a quote Inventory never gave: applied at what was charged, warned, nothing counted', s5?.answer === 'APPLIED' && (s5?.warnings ?? []).some((w: string) => /not one Inventory gave/.test(w)) && (await counted(`INV/BAD/${STAMP}-L5`)).length === 0, `${s5?.answer} ${JSON.stringify(s5?.warnings)}`);
    const s5b: any = await applySale(CLIENT, store.id, bill('L5B', null, [{ ...quotedLine(q1, A), offers: [{ offerId: auto.id, discountPaise: 60000 }] }]) as any);
    check('offers on the lines but no quote at all: applied, warned, nothing counted', s5b?.answer === 'APPLIED' && (s5b?.warnings ?? []).some((w: string) => /no quote/.test(w)) && (await counted(`INV/BAD/${STAMP}-L5B`)).length === 0, `${s5b?.answer} ${JSON.stringify(s5b?.warnings)}`);

    const q6 = await quote([{ itemCode: A, qty: 3 }]);
    await prisma.pricingQuote.update({ where: { id: q6.data.data.quoteId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const s6: any = await applySale(CLIENT, store.id, bill('L6', q6.data.data.quoteId, [quotedLine(q6, A)]) as any);
    check('a quote that had expired when the bill was made: applied, warned, nothing counted', s6?.answer === 'APPLIED' && (s6?.warnings ?? []).some((w: string) => /expired/.test(w)) && (await counted(`INV/BAD/${STAMP}-L6`)).length === 0, `${s6?.answer} ${JSON.stringify(s6?.warnings)}`);
    const q7 = await quote([{ itemCode: A, qty: 4 }]);
    await prisma.pricingQuote.update({ where: { id: q7.data.data.quoteId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const before7 = await usage(auto.id);
    const s7: any = await applySale(CLIENT, store.id, bill('L7', q7.data.data.quoteId, [quotedLine(q7, A)], { occurredAt: new Date(Date.now() - 10 * 60_000).toISOString() }) as any);
    check('an offline till: the bill was MADE before the quote expired and arrives after -- still counted', s7?.answer === 'APPLIED' && !(s7?.warnings?.length) && (await counted(`INV/BAD/${STAMP}-L7`)).length === 1 && await usage(auto.id) === before7 + 1, `${s7?.answer} ${JSON.stringify(s7?.warnings)}`);

    const only = await offer({ name: 'Only one', trigger: 'AUTOMATIC', value: 15, usageLimit: 1 });
    const q8a = await quote([{ itemCode: A, qty: 8 }]);
    const q8b = await quote([{ itemCode: B, qty: 2 }]);
    check('a 15% offer with one use left beats the 10% one on both quotes', q8a.data?.data?.lines?.[0]?.offers?.[0]?.offerId === only.id && q8b.data?.data?.lines?.[0]?.offers?.[0]?.offerId === only.id, JSON.stringify([q8a.data?.data?.lines?.[0]?.offers, q8b.data?.data?.lines?.[0]?.offers]));
    const s8a: any = await applySale(CLIENT, store.id, bill('L8A', q8a.data.data.quoteId, [quotedLine(q8a, A)]) as any);
    const s8b: any = await applySale(CLIENT, store.id, bill('L8B', q8b.data.data.quoteId, [quotedLine(q8b, B)]) as any);
    check('the first bill uses the last slot; the second, quoted before that, is applied at what was charged with a warning and not counted', s8a?.answer === 'APPLIED' && (await counted(`INV/BAD/${STAMP}-L8A`)).length === 1 && s8b?.answer === 'APPLIED' && (s8b?.warnings ?? []).some((w: string) => /as many times/.test(w)) && (await counted(`INV/BAD/${STAMP}-L8B`)).length === 0 && await usage(only.id) === 1, `${s8a?.answer} / ${s8b?.answer} ${JSON.stringify(s8b?.warnings)} usage=${await usage(only.id)}`);
    await offerService.setStatus(CLIENT, only.id, 'PAUSED');

    /*
     * Through the door. The LOCAL worker is switched off (it must not race the live one on the
     * shared database), so a queued event is applied by the live backend -- with whatever code is
     * live. What can be proved here is that the door keeps the quote and the offers on the row the
     * worker will read; applySale above proves what the worker then does with them.
     */
    const sent9 = await send(t3.key, bill('L9', '00000000-0000-4000-8000-000000000009', [{ ...quotedLine(q1, A), offers: [{ offerId: auto.id, discountPaise: 60000 }] }]));
    const row9: any = await prisma.posInboundEvent.findFirst({ where: { clientId: CLIENT, invoiceNo: `INV/BAD/${STAMP}-L9` }, select: { payload: true } });
    check('through the door: the row the worker reads keeps the quoteId and the offers on the lines', sent9.answer === 'APPLIED' && row9?.payload?.quoteId === '00000000-0000-4000-8000-000000000009' && row9?.payload?.lines?.[0]?.offers?.[0]?.offerId === auto.id, `${sent9.answer} ${JSON.stringify(row9?.payload?.lines?.[0]?.offers)}`);

    const cat1 = await api(t3.key).get('/catalogue?limit=1');
    check('the catalogue carries the discount limit as an explicit shape: no limit set -> { unlimited: true }', cat1.status === 200 && JSON.stringify(cat1.data?.data?.manualDiscount) === JSON.stringify({ unlimited: true }), JSON.stringify(cat1.data?.data?.manualDiscount));
    await prisma.clientSettings.update({ where: { clientId: CLIENT }, data: { manualDiscountMaxPercent: 15 } });
    await new Promise(r => setTimeout(r, 61_000)); // the server caches shop settings for 60 s
    const cat2 = await api(t3.key).get('/catalogue?limit=1');
    check('  ...a limit of 15% -> { maxPercent: 15 } (a minute later: the server caches settings for 60 s)', JSON.stringify(cat2.data?.data?.manualDiscount) === JSON.stringify({ maxPercent: 15 }), JSON.stringify(cat2.data?.data?.manualDiscount));
    await posConnectionService.disconnect(CLIENT, t3.id);
    }
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
    check('they cannot see the bills left out of Inventory', await as('/pos-connections/left-out') === 403);
    check('they cannot replace or disconnect one',await as('/pos-connections/00000000-0000-0000-0000-000000000000/replace-key', 'POST') === 403 && await as('/pos-connections/00000000-0000-0000-0000-000000000000/disconnect', 'POST') === 403);
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
