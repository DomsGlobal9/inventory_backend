/**
 * Every flow built over the last two days, through the real HTTP endpoints, on ONE shop.
 *
 * Not a unit suite: this exists so the same bill can be followed through the UI afterwards. It
 * puts a sale, a part-payment collected later, a return with its credit note, an oversell and an
 * exchange onto the tenant the app logs into, and prints what to look for on each screen.
 *
 *   npx tsx src/scripts/e2e-all-flows.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';

const BASE = 'http://localhost:4006/api/v1/pos/v1';
const CLIENT = 'verify-suites-tenant';
const STAMP = Date.now() % 100000;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

const api = (key: string) => axios.create({
  baseURL: BASE, headers: { 'X-Storefront-Key': key },
  validateStatus: () => true, timeout: 120_000
});

async function settle(key: string, body: any) {
  const r = await api(key).post('/events', body);
  if (r.data?.data?.answer !== 'ACCEPTED') return r;
  const number = String(
    body.kind === 'payment.updated' ? body.idempotencyKey
    : body.kind === 'sale.exchanged' ? body.exchangeNo
    : (body.creditNoteNo ?? body.invoiceNo ?? '')
  );
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const s = await api(key).get(`/events/status?invoiceNo=${encodeURIComponent(number)}`);
    const d = s.data?.data;
    if (d && (d.status === 'APPLIED' || d.status === 'REJECTED')) {
      const ok = d.answer === 'APPLIED' || d.answer === 'ALREADY_APPLIED';
      return { ...r, status: ok ? 200 : 422, data: { success: ok, data: d } };
    }
    await new Promise(res => setTimeout(res, 500));
  }
  throw new Error(`${number} never settled -- is the worker scoped to ${CLIENT}?`);
}

async function main() {
  console.log(`\nEvery flow, on ${CLIENT}\n`);

  const location = await prisma.stockLocation.findFirst({
    where: { clientId: CLIENT, active: true }, select: { id: true, name: true }
  });
  if (!location) throw new Error('That shop has no location.');

  // A product of its own, so nothing already on the tenant can be disturbed.
  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: `E2E-${STAMP}`, slug: `e2e-${STAMP}`,
      title: `Kanchipuram silk saree (E2E ${STAMP})`, category: 'WOMEN' as any,
      productType: 'READY_TO_WEAR' as any, dressType: 'Saree', fabric: 'Silk',
      basePrice: 3000, status: 'ACTIVE' as any, publishedAt: new Date(),
      hsnCode: '5007', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
    }
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id, clientId: CLIENT, colorName: 'Peacock', size: 'Free Size',
      variantCode: `E2EV-${STAMP}`, sku: `E2ES-${STAMP}`, sellingPrice: 3000
    }
  });
  await prisma.inventoryStock.create({
    data: { clientId: CLIENT, variantId: variant.id, locationId: location.id, quantity: 10, reservedQty: 0 }
  });

  const cred = generateCredential();
  await prisma.storefrontConnection.create({
    data: {
      clientId: CLIENT, name: `E2E till ${STAMP}`, baseUrl: POS_BASE_URL, // a till key (utils/posConnection): /pos/v1 refuses website keys
      credentialHash: cred.hash, credentialPrefix: cred.prefix,
      status: 'ACTIVE', locationIds: [location.id]
    }
  });
  const key = cred.plaintext;

  // ── 1. a sale, part paid ────────────────────────────────────────────────────────────────
  console.log('1. A SALE WITH A DEPOSIT (the kept order)');
  const kept = `INV/E2E/${STAMP}-KEPT`;
  const t0 = Date.now();
  const sale = await settle(key, {
    kind: 'sale.completed', invoiceNo: kept, occurredAt: new Date().toISOString(),
    customer: { phone: '9989075480', name: 'E2E Customer' },
    lines: [{ itemCode: variant.variantCode, qty: 2, unitPricePaise: 300000, lineTotalPaise: 600000 }],
    totals: {}, payments: [{ method: 'CASH', amountPaise: 200000 }]
  });
  check('a deposit-only sale is recorded, not refused', sale.data?.data?.answer === 'APPLIED',
    JSON.stringify(sale.data?.data?.orderNumber));
  const keptNo = sale.data?.data?.orderNumber;
  console.log(`      took ${Date.now() - t0}ms end to end (till waits ~1s of that)`);

  // ── 2. the balance, collected later ─────────────────────────────────────────────────────
  console.log('\n2. THE BALANCE, COLLECTED A WEEK LATER');
  const pay = await settle(key, {
    kind: 'payment.updated', invoiceNo: kept, idempotencyKey: `e2e-bal-${STAMP}`,
    occurredAt: new Date().toISOString(),
    payments: [{ method: 'UPI', amountPaise: 400000, reference: `utr-${STAMP}` }]
  });
  check('the balance is collected and the bill is settled',
    pay.data?.data?.answer === 'APPLIED' && /Paid in full/.test(pay.data?.data?.detail ?? ''),
    pay.data?.data?.detail);

  // ── 3. a return, with its credit note ───────────────────────────────────────────────────
  console.log('\n3. ONE PIECE BACK, WITH A CREDIT NOTE');
  const cn = `CN/E2E/${STAMP}`;
  const ret = await settle(key, {
    kind: 'sale.returned', creditNoteNo: cn, againstInvoiceNo: kept,
    lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {},
    refund: { method: 'UPI', reference: `refund-${STAMP}` }
  });
  check('the return is applied', ret.data?.data?.answer === 'APPLIED',
    JSON.stringify(ret.data?.data?.orderNumber));

  const returnRow = await prisma.salesReturn.findFirst({
    where: { clientId: CLIENT, returnNumber: ret.data?.data?.orderNumber },
    select: { creditNoteNo: true, cgst: true, sgst: true, refundTotal: true, returnNumber: true }
  });
  check('it was issued a GST credit note, in its own series',
    /^CRN\//.test(returnRow?.creditNoteNo ?? ''), String(returnRow?.creditNoteNo));
  check('and the tax it reverses came back with it',
    Number(returnRow?.cgst ?? 0) + Number(returnRow?.sgst ?? 0) > 0,
    `cgst ${returnRow?.cgst} sgst ${returnRow?.sgst}`);

  // ── 4. an oversell, then a return onto a negative shelf ──────────────────────────────────
  console.log('\n4. SELLING MORE THAN THE SHELF HAS, THEN TAKING ONE BACK');
  await prisma.inventoryStock.updateMany({
    where: { clientId: CLIENT, variantId: variant.id }, data: { quantity: 1, reservedQty: 0 }
  });
  const over = `INV/E2E/${STAMP}-OVER`;
  const oversold = await settle(key, {
    kind: 'sale.completed', invoiceNo: over, occurredAt: new Date().toISOString(),
    lines: [{ itemCode: variant.variantCode, qty: 3, unitPricePaise: 300000, lineTotalPaise: 900000 }],
    totals: {}, payments: [{ method: 'CASH', amountPaise: 900000 }]
  });
  check('a sale for stock we did not have is recorded, not refused',
    oversold.data?.data?.answer === 'APPLIED', JSON.stringify(oversold.data?.data?.warnings));
  const neg = await prisma.inventoryStock.findFirst({
    where: { clientId: CLIENT, variantId: variant.id }, select: { quantity: true }
  });
  check('the count went honestly negative', neg?.quantity === -2, String(neg?.quantity));

  const cnNeg = `CN/E2E/${STAMP}-NEG`;
  const backOnNeg = await settle(key, {
    kind: 'sale.returned', creditNoteNo: cnNeg, againstInvoiceNo: over,
    lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }], totals: {},
    refund: { method: 'CASH' }
  });
  check('a return onto a NEGATIVE shelf still works', backOnNeg.data?.data?.answer === 'APPLIED',
    JSON.stringify(backOnNeg.data?.data?.answer));

  // ── 5. an exchange ──────────────────────────────────────────────────────────────────────
  console.log('\n5. A SWAP: 3,000 FOR 4,500, PAYING THE DIFFERENCE');
  await prisma.inventoryStock.updateMany({
    where: { clientId: CLIENT, variantId: variant.id }, data: { quantity: 10, reservedQty: 0 }
  });
  const base = `INV/E2E/${STAMP}-SWAPBASE`;
  await settle(key, {
    kind: 'sale.completed', invoiceNo: base, occurredAt: new Date().toISOString(),
    lines: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: 300000, lineTotalPaise: 300000 }],
    totals: {}, payments: [{ method: 'CASH', amountPaise: 300000 }]
  });
  const ex = `EXC/E2E/${STAMP}`;
  const swap = await settle(key, {
    kind: 'sale.exchanged', exchangeNo: ex, againstInvoiceNo: base,
    occurredAt: new Date().toISOString(),
    returned: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: 300000 }],
    sold: [{ itemCode: variant.variantCode, qty: 1, unitPricePaise: 450000, lineTotalPaise: 450000 }],
    payments: [{ method: 'CASH', amountPaise: 150000 }]
  });
  check('the swap is applied', swap.data?.data?.answer === 'APPLIED',
    JSON.stringify(swap.data?.data?.orderNumber));

  const swapOrder = await prisma.salesOrder.findFirst({
    where: { clientId: CLIENT, externalOrderId: ex }, select: { id: true, orderNumber: true }
  });
  const swapRows = await prisma.salesOrderPayment.findMany({
    where: { clientId: CLIENT, salesOrderId: swapOrder?.id },
    select: { method: true, amount: true, settlesReturnId: true }
  });
  const realMoney = swapRows.filter(r => r.settlesReturnId === null)
    .reduce((a, r) => a + Number(r.amount), 0);
  check('only the real difference counts as money -- 1,500, not 4,500', realMoney === 1500,
    JSON.stringify(swapRows.map(r => `${r.method} ${r.amount}${r.settlesReturnId ? ' (settled)' : ''}`)));

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
  console.log('\n──────── WHAT TO LOOK AT IN THE UI ────────');
  console.log(`  Product      ${product.title}`);
  console.log(`  Kept order   ${keptNo}  (${kept}) -- deposit then balance, now paid in full`);
  console.log(`  Credit note  ${returnRow?.creditNoteNo} on ${returnRow?.returnNumber}`);
  console.log(`  Exchange     ${swapOrder?.orderNumber}  (${ex}) -- takings should read 1,500`);
  console.log(`  Day Book     today, at ${location.name}`);
  console.log('───────────────────────────────────────────');

  await prisma.$disconnect();
}
main().catch(async e => { console.log('CRASHED:', e.message); await prisma.$disconnect(); });
