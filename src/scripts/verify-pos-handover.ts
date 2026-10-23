/**
 * Kept orders from the till: `handover` + `promisedAt` on sale.completed, and order.handed_over.
 * Hand-overs through the real door (/pos/v1/events) with a till key; sales applied in-process (see sell). A throwaway shop.
 *
 *   A  a kept sale lands KEEP_FOR_CUSTOMER with its promised date; its stock still leaves at once
 *   B  no handover, a value we don't know, a bad date, a date on a taken-now sale: applied, never refused
 *   C  order.handed_over dates the hand-over once; the same again is ALREADY_APPLIED and changes nothing
 *   D  a sale filed TAKEN_NOW (sent before the till had the field) becomes a kept order handed over
 *   E  refusals: no invoiceNo, a bill we never had
 *   F  a hand-over that overtakes its sale (held still, not timed): 409, try again -- never a queue stop
 *   G  a bill the owner left out: noted, nothing to hand over
 *   H  the till's time: kept within 7 days, a future or unreadable one is now
 *   I  /events/status still answers about the sale, not the hand-over
 *
 *   npx tsx src/scripts/verify-pos-handover.ts     (needs the local backend on :4006)
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { applySale } from '../services/pos/pos-events.service';

const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const CLIENT = `pos-handover-${STAMP}`;
const PRICE = 250000; // paise
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 220)}`;

async function teardown() {
  const w = { clientId: CLIENT };
  const steps: [string, () => Promise<unknown>][] = [
    ['pos events', () => prisma.posInboundEvent.deleteMany({ where: w })],
    ['payments', () => prisma.salesOrderPayment.deleteMany({ where: w })],
    ['dispatch items', () => prisma.dispatchItem.deleteMany({ where: { dispatch: w } })],
    ['dispatches', () => prisma.dispatch.deleteMany({ where: w })],
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
  console.log(`\nKept orders from the till, on ${CLIENT}\n`);
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Counter', code: `HO-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.clientSettings.create({ data: { clientId: CLIENT, businessName: 'Handover Test Shop', gstRegistration: 'UNREGISTERED' } });
  const product = await prisma.product.create({ data: { clientId: CLIENT, productCode: `HOP-${STAMP}`, slug: `hop-${STAMP}`, title: 'Kept lehenga', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Lehenga', basePrice: 2500, status: 'ACTIVE' as any, publishedAt: new Date() } });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, clientId: CLIENT, colorName: 'Maroon', size: 'M', variantCode: `HOV-${STAMP}`, sku: `HOS-${STAMP}`, sellingPrice: 2500 } });
  await inventoryMutationService.applyMovement({ clientId: CLIENT, variantId: variant.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE', quantityDelta: 20, unitCost: 1000, notes: 'verify-pos-handover setup', createdBy: 'verify-pos-handover' });
  const till = await posConnectionService.create(CLIENT, { locationId: store.id, name: 'Till' });
  const T = axios.create({ baseURL: `${API}/pos/v1`, headers: { 'X-Storefront-Key': till.key }, validateStatus: () => true });

  const inv = (n: string) => `INV/HO/${STAMP}-${n}`;
  const sale = (n: string, extra: Record<string, unknown> = {}) => ({
    kind: 'sale.completed', invoiceNo: inv(n), occurredAt: new Date().toISOString(),
    lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: PRICE, lineTotalPaise: PRICE }], totals: {},
    payments: [{ method: 'CASH', amountPaise: 50000 }], ...extra
  });
  const handedOver = (n: string, extra: Record<string, unknown> = {}) => ({ kind: 'order.handed_over', invoiceNo: inv(n), handedOverAt: new Date().toISOString(), duePaise: 200000, ...extra });
  const order = (n: string) => prisma.salesOrder.findFirst({ where: { clientId: CLIENT, externalOrderId: inv(n) }, select: { id: true, orderNumber: true, handover: true, promisedAt: true, handedOverAt: true, status: true } });
  const onHand = async () => (await prisma.inventoryStock.findFirst({ where: { clientId: CLIENT, variantId: variant.id, locationId: store.id } }))?.quantity;

  /*
   * Sales are applied here, in this process, with this code -- NOT sent through the door's queue.
   * The database is shared with production, and the live server's worker takes any QUEUED sale it
   * finds, test shops included, with whatever code is deployed: a sale sent through the door was
   * applied by the old build (TAKEN_NOW) and the check blamed the new one (23 Oct). Hand-overs do go
   * through the door: they are applied on the spot by the local server and never queued.
   */
  const sell = (n: string, extra: Record<string, unknown> = {}) => applySale(CLIENT, store.id, sale(n, extra) as any);

  try {
    console.log('A. A KEPT SALE');
    const before = await onHand();
    const a1 = await sell('A', { handover: 'KEEP_FOR_CUSTOMER', promisedAt: '2026-10-25' });
    const oa = await order('A');
    check('applied, no warnings', a1.answer === 'APPLIED' && !a1.warnings?.length && !!oa, JSON.stringify(a1));
    check('filed KEEP_FOR_CUSTOMER, promised 25 Oct, not handed over yet',
      oa?.handover === 'KEEP_FOR_CUSTOMER' && oa?.promisedAt?.toISOString().slice(0, 10) === '2026-10-25' && oa?.handedOverAt === null, JSON.stringify(oa));
    check('its stock left at the sale, as before (20 -> 19)', before === 20 && await onHand() === 19, `${before} -> ${await onHand()}`);

    console.log('\nB. NEVER REFUSED OVER THE NEW FIELDS');
    await sell('B1');
    check('no handover at all: TAKEN_NOW (today\'s behaviour)', (await order('B1'))?.handover === 'TAKEN_NOW', JSON.stringify(await order('B1')));
    await sell('B2', { handover: 'kept', promisedAt: '2026-10-25' });
    const ob2 = await order('B2');
    check('a value we don\'t know ("kept"): applied as TAKEN_NOW, and its date ignored', ob2?.handover === 'TAKEN_NOW' && ob2?.promisedAt === null, JSON.stringify(ob2));
    await sell('B3', { handover: 'KEEP_FOR_CUSTOMER', promisedAt: '2026-02-30' });
    const ob3 = await order('B3');
    check('a kept sale with an impossible date (30 Feb): kept, date dropped', ob3?.handover === 'KEEP_FOR_CUSTOMER' && ob3?.promisedAt === null, JSON.stringify(ob3));
    await sell('B4', { handover: 'TAKEN_NOW', promisedAt: '2026-10-25' });
    const ob4 = await order('B4');
    check('taken now with a date: the date is ignored (only kept orders have one)', ob4?.handover === 'TAKEN_NOW' && ob4?.promisedAt === null, JSON.stringify(ob4));

    console.log('\nC. HANDED OVER');
    const at = new Date(Date.now() - 3 * 3600_000).toISOString();
    const stockBefore = await onHand();
    const c1 = await T.post('/events', handedOver('A', { handedOverAt: at }));
    const oc = await order('A');
    check('200 APPLIED with the order number', c1.status === 200 && c1.data?.data?.answer === 'APPLIED' && c1.data?.data?.orderNumber === oa?.orderNumber, brief(c1));
    check('  ...dated at the till\'s time (3 hours ago), still kept', oc?.handedOverAt?.toISOString() === at && oc?.handover === 'KEEP_FOR_CUSTOMER', JSON.stringify(oc));
    check('  ...no stock moved', await onHand() === stockBefore, `${stockBefore} -> ${await onHand()}`);
    const c2 = await T.post('/events', handedOver('A', { handedOverAt: new Date().toISOString() }));
    const oc2 = await order('A');
    check('the same hand-over again: 200 ALREADY_APPLIED, the first date kept', c2.status === 200 && c2.data?.data?.answer === 'ALREADY_APPLIED' && oc2?.handedOverAt?.toISOString() === at, `${brief(c2)} ${oc2?.handedOverAt?.toISOString()}`);

    console.log('\nD. A SALE SENT BEFORE THE TILL HAD THE FIELD');
    const d1 = await T.post('/events', handedOver('B1'));
    const od = await order('B1');
    check('handing over a TAKEN_NOW sale: applied, now KEEP_FOR_CUSTOMER with a date', d1.status === 200 && d1.data?.data?.answer === 'APPLIED' && od?.handover === 'KEEP_FOR_CUSTOMER' && !!od?.handedOverAt, `${brief(d1)} ${JSON.stringify(od)}`);

    console.log('\nE. REFUSALS');
    const e1 = await T.post('/events', { kind: 'order.handed_over', handedOverAt: new Date().toISOString() });
    check('no invoiceNo: 422 BAD_PAYLOAD in words', e1.status === 422 && e1.data?.data?.answer === 'BAD_PAYLOAD' && /invoiceNo/.test(e1.data?.data?.detail ?? ''), brief(e1));
    const e2 = await T.post('/events', handedOver('NEVER'));
    check('a bill we never had: 422 UNKNOWN_ORDER', e2.status === 422 && e2.data?.data?.answer === 'UNKNOWN_ORDER', brief(e2));
    check('  ...and nothing was recorded for it', await prisma.posInboundEvent.count({ where: { clientId: CLIENT, kind: 'order.handed_over', invoiceNo: inv('NEVER') } }) === 0);

    console.log('\nF. A HAND-OVER THAT OVERTAKES ITS SALE');
    // The moment between "taken in" and "applied", held still: a sale row being worked on right now
    // (RUNNING, fresh heartbeat), which no worker picks up, with no order yet.
    const f0 = await prisma.posInboundEvent.create({ data: { clientId: CLIENT, locationId: store.id, kind: 'sale.completed', invoiceNo: inv('F'), payload: sale('F', { handover: 'KEEP_FOR_CUSTOMER' }) as any, status: 'RUNNING', heartbeatAt: new Date() } });
    const f1 = await T.post('/events', handedOver('F'));
    check('the sale taken in but not applied yet: 409 SALE_NOT_YET_APPLIED (try again), not a stop', f1.status === 409 && f1.data?.data?.answer === 'SALE_NOT_YET_APPLIED', brief(f1));
    check('  ...and nothing was recorded for the hand-over', await prisma.posInboundEvent.count({ where: { clientId: CLIENT, kind: 'order.handed_over', invoiceNo: inv('F') } }) === 0);
    await prisma.posInboundEvent.delete({ where: { id: f0.id } });
    await sell('F', { handover: 'KEEP_FOR_CUSTOMER' });
    const f2 = await T.post('/events', handedOver('F'));
    check('  ...sent again once the sale is in: APPLIED', f2.status === 200 && f2.data?.data?.answer === 'APPLIED' && !!(await order('F'))?.handedOverAt, brief(f2));

    console.log('\nG. A BILL THE OWNER LEFT OUT');
    const g0 = await T.post('/events', { kind: 'document.skipped', document: inv('G'), eventType: 'sale.completed', reason: 'Item was not in Inventory, left out by the owner.' });
    const g1 = await T.post('/events', handedOver('G'));
    check('left out, then handed over: 200 APPLIED with a note, nothing to change', g0.status === 200 && g1.status === 200 && g1.data?.data?.answer === 'APPLIED' && !(await order('G')), `${brief(g0)} | ${brief(g1)}`);
    const gRow = await prisma.posInboundEvent.findFirst({ where: { clientId: CLIENT, kind: 'order.handed_over', invoiceNo: inv('G') } });
    check('  ...noted as left out', /left out/.test(gRow?.detail ?? ''), JSON.stringify(gRow?.detail));

    console.log('\nH. THE TILL\'S TIME');
    await sell('H1', { handover: 'KEEP_FOR_CUSTOMER' });
    await sell('H2', { handover: 'KEEP_FOR_CUSTOMER' });
    const t0 = Date.now();
    await T.post('/events', handedOver('H1', { handedOverAt: new Date(t0 + 86_400_000).toISOString() }));
    await T.post('/events', handedOver('H2', { handedOverAt: 'yesterday-ish' }));
    const h1 = (await order('H1'))?.handedOverAt?.getTime() ?? 0, h2 = (await order('H2'))?.handedOverAt?.getTime() ?? 0;
    check('a time in the future is taken as now', Math.abs(h1 - t0) < 120_000, new Date(h1).toISOString());
    check('an unreadable time is taken as now', Math.abs(h2 - t0) < 120_000, new Date(h2).toISOString());

    console.log('\nI. "WHERE DID THAT BILL GET TO?"');
    // Sales here were applied in-process, so the only row stored for bill A is its hand-over.
    const i1 = await T.get('/events/status', { params: { invoiceNo: inv('A') } });
    check('only a hand-over stored for the bill: 404 UNKNOWN_ORDER -- a hand-over is never reported as the bill', i1.status === 404 && i1.data?.data?.answer === 'UNKNOWN_ORDER', brief(i1));
    // The sale's row as the door writes it, received an hour BEFORE the hand-over (the newest row).
    await prisma.posInboundEvent.create({ data: { clientId: CLIENT, locationId: store.id, kind: 'sale.completed', invoiceNo: inv('A'), payload: sale('A') as any, status: 'APPLIED', answer: 'APPLIED', orderNumber: oa?.orderNumber, receivedAt: new Date(Date.now() - 3600_000), settledAt: new Date(Date.now() - 3600_000) } });
    const i2 = await T.get('/events/status', { params: { invoiceNo: inv('A') } });
    check('with the sale stored: answers about the sale (APPLIED, its order number), though the hand-over is newer', i2.status === 200 && i2.data?.data?.status === 'APPLIED' && i2.data?.data?.orderNumber === oa?.orderNumber, brief(i2));
  } finally {
    await teardown();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async e => { console.error(e); await teardown(); process.exit(1); });
