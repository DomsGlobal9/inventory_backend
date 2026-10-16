/**
 * Gift vouchers, part B: spending and returns. Writes VOUCHER payment rows, so it runs only once the
 * deployed backend knows VOUCHER (the shared-DB enum rule): it refuses unless Render's /health shows
 * this checkout's HEAD, or FORCE_AFTER_DEPLOY=1. Real HTTP with real till keys; the sale and return
 * events through the same functions the event worker calls; a throwaway shop of its own.
 *
 *   H  holds: reserve takes from what is left; a second till meets NOT_ENOUGH; two tills at once get
 *      one yes; more than the bill, unknown, expired and blocked refused in words; confirm and release
 *   S  the sale: the voucher row is settled in the order's transaction (balance down, USED entry, a
 *      VOUCHER payment row); walk-ins can spend one; two vouchers on one bill; the same event twice
 *      moves nothing; spending a voucher earns no loyalty points; a hold already used warns
 *   R  returns: the voucher-paid part goes back onto the voucher (REFUNDED, VOUCHER refund row),
 *      an expired voucher gets 30 days; a bill not paid by voucher cannot refund onto one
 *   W  the sweep: a never-confirmed reserve past its time frees the balance
 *   D  the Day Book: vouchers used today
 *
 *   npx tsx src/scripts/verify-gift-vouchers-spend.ts     (needs the local backend on :4006)
 */
import axios from 'axios';
import { execSync } from 'node:child_process';
import { prisma } from '../lib/prisma';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { applySale } from '../services/pos/pos-events.service';
import { applyReturn } from '../services/pos/pos-returns.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import * as gv from '../services/gift-vouchers';
import { dayBookService } from '../services/daybook.service';

const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const LIVE = 'https://inventory-backend-1-ym8d.onrender.com/health';
const STAMP = Date.now();
const C = `gvs-${STAMP}`;
const PRICE = 300000;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 260)}`;
const ans = (r: any) => r.data?.data?.answer;

/**
 * The live backend must already carry the voucher migration -- not merely match this checkout's last
 * commit (on 16 Oct an earlier version compared HEAD with the live commit before the voucher work was
 * committed, both were the old commit, and this ran too early).
 */
async function deployedFirst() {
  if (process.env.FORCE_AFTER_DEPLOY === '1') return true;
  const live = await fetch(LIVE).then(r => r.json()).then((j: any) => j.commit as string).catch(() => null);
  let carries = false;
  try { execSync(`git cat-file -e ${live}:prisma/migrations/20261016100000_gift_vouchers/migration.sql`, { cwd: __dirname, stdio: 'ignore' }); carries = !!live; } catch { carries = false; }
  if (!carries) {
    console.log(`\nNot run: the live backend (${live}) does not have the gift voucher change yet.\nPush and Deploy first (VOUCHER is a database enum value), then run this again.`);
    return false;
  }
  return true;
}

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: C, name: 'Counter', code: `GS-${STAMP}`, type: 'STORE' as any, active: true } });
  await prisma.clientSettings.create({ data: { clientId: C, businessName: 'Voucher Spend Shop', gstRegistration: 'UNREGISTERED' } as any });
  await prisma.loyaltySettings.create({ data: { clientId: C, enabled: true, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 100, maxRedeemPercent: 50, expiryMonths: 12, earnAtCounter: true } as any });
  await gv.saveSettings(C, { enabled: true }, 'tester');
  const product = await prisma.product.create({ data: { clientId: C, productCode: `GP-${STAMP}`, slug: `gp-${STAMP}`, title: 'Voucher saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 3000, status: 'ACTIVE' as any, publishedAt: new Date() } as any });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, clientId: C, colorName: 'Red', size: 'Free', variantCode: `GV-${STAMP}`, sku: `GS-${STAMP}`, sellingPrice: 3000 } });
  await inventoryMutationService.applyMovement({ clientId: C, variantId: variant.id, locationId: store.id, movementType: 'IN', reason: 'PURCHASE', quantityDelta: 50, unitCost: 1200, notes: 'voucher spend setup', createdBy: 'verify-gift-vouchers-spend' } as any);
  const phone = `+919${String(STAMP).slice(-9)}`;
  const cust = await prisma.customer.create({ data: { clientId: C, customerCode: `GSC-${STAMP}`, name: 'Anita Rao', phone, externalCustomerId: `POS:${phone}` } });
  const tA = await posConnectionService.create(C, { locationId: store.id, name: 'Till A' });
  const tB = await posConnectionService.create(C, { locationId: store.id, name: 'Till B' });
  const A = axios.create({ baseURL: `${API}/pos/v1`, headers: { 'X-Storefront-Key': tA.key }, validateStatus: () => true });
  const B = axios.create({ baseURL: `${API}/pos/v1`, headers: { 'X-Storefront-Key': tB.key }, validateStatus: () => true });
  let k = 0;
  const sellV = async (paise: number) => (await A.post('/vouchers', { idempotencyKey: `s-${STAMP}-${++k}`, amountPaise: paise, payments: [{ method: 'CASH', amountPaise: paise }] })).data.data.code as string;
  const hold = (http: any, code: string, amount: number, bill: number) => http.post('/holds', { idempotencyKey: `h-${STAMP}-${++k}`, kind: 'VOUCHER', voucherCode: code, amount, billPaise: bill });
  const balance = async (code: string) => (await prisma.giftVoucher.findFirstOrThrow({ where: { clientId: C, code } })).balancePaise;
  const left = async (code: string) => (await A.get(`/vouchers/${code}`)).data.data.balancePaise as number;
  const bill = (inv: string, qty: number, payments: any[], customer: any = { name: 'Anita Rao', phone }) => ({
    kind: 'sale.completed', invoiceNo: `INV/GV/${STAMP}-${inv}`, occurredAt: new Date().toISOString(), customer,
    lines: [{ itemCode: variant.variantCode, qty, unitPricePaise: PRICE, lineTotalPaise: PRICE * qty }], totals: {}, payments
  });
  const orderOf = (inv: string) => prisma.salesOrder.findFirstOrThrow({ where: { clientId: C, externalOrderId: `INV/GV/${STAMP}-${inv}` } });

  const V1 = await sellV(500000), V2 = await sellV(200000), V3 = await sellV(400000), V4 = await sellV(100000);

  console.log('\nH. HOLDS');
  const h1 = await hold(A, V1, 300000, 600000);
  check('reserve ₹3,000 of a ₹5,000 voucher: RESERVED, and checking now shows ₹2,000 left', h1.status === 200 && h1.data.data.status === 'RESERVED' && await left(V1) === 200000, brief(h1));
  const hB = await hold(B, V1, 300000, 600000);
  check('another till asking for ₹3,000 more: 409 NOT_ENOUGH, says what is left', hB.status === 409 && ans(hB) === 'NOT_ENOUGH' && /₹2,000/.test(hB.data.data.detail), brief(hB));
  const race = await Promise.all([hold(A, V3, 400000, 400000), hold(B, V3, 400000, 400000)]);
  check('two tills taking the whole ₹4,000 voucher at the same moment: exactly one yes', race.filter(r => r.status === 200).length === 1 && race.filter(r => ans(r) === 'NOT_ENOUGH').length === 1, race.map(brief));
  await A.delete(`/holds/${race.find(r => r.status === 200)!.data.data.holdId}`);
  check('releasing it frees the voucher again', await left(V3) === 400000);
  const over = await hold(A, V2, 300000, 200000);
  check('more than the bill: refused in words', over.status === 422 && /more than the bill/.test(over.data?.data?.detail ?? ''), brief(over));
  const nope = await hold(A, 'GV-ZZZZ-ZZZZ', 1000, 2000);
  check('an unknown code: 404 UNKNOWN_VOUCHER', nope.status === 404 && ans(nope) === 'UNKNOWN_VOUCHER', brief(nope));
  const oldV = await prisma.giftVoucher.create({ data: { clientId: C, code: 'GV-OLDD-AAAA', initialPaise: 100000, balancePaise: 100000, expiresAt: new Date(Date.now() - 86_400_000) } });
  const he = await hold(A, oldV.code, 1000, 2000);
  check('an expired voucher: 409 EXPIRED, says when', he.status === 409 && ans(he) === 'EXPIRED' && /expired on/.test(he.data.data.detail), brief(he));
  const blockedId = (await prisma.giftVoucher.findFirstOrThrow({ where: { clientId: C, code: V4 } })).id;
  await gv.block(C, blockedId, 'lost', 'tester');
  const hbk = await hold(A, V4, 1000, 2000);
  check('a blocked voucher: 409 BLOCKED', hbk.status === 409 && ans(hbk) === 'BLOCKED', brief(hbk));
  await gv.unblock(C, blockedId, 'tester');
  const conf = await A.post(`/holds/${h1.data.data.holdId}/confirm`, { invoiceNo: `INV/GV/${STAMP}-S1` });
  check('confirm: CONFIRMED; releasing it after is refused', conf.data?.data?.status === 'CONFIRMED' && (await A.delete(`/holds/${h1.data.data.holdId}`)).status === 409, brief(conf));

  console.log('\nS. THE SALE');
  const s1: any = await applySale(C, store.id, bill('S1', 2, [{ method: 'VOUCHER', amountPaise: 300000, holdId: h1.data.data.holdId, reference: V1 }, { method: 'CASH', amountPaise: 300000 }]) as any);
  const o1 = await orderOf('S1');
  const rows1 = await prisma.salesOrderPayment.findMany({ where: { clientId: C, salesOrderId: o1.id }, select: { method: true, amount: true, reference: true } });
  const used1 = await prisma.giftVoucherEntry.findFirst({ where: { clientId: C, salesOrderId: o1.id, kind: 'USED' } });
  check('applied with no warnings; ₹5,000 → ₹2,000; a USED entry for the order; a VOUCHER payment row with the code',
    s1?.answer === 'APPLIED' && !(s1?.warnings?.length) && await balance(V1) === 200000 && used1?.amountPaise === -300000 && rows1.some(r => r.method === 'VOUCHER' && Number(r.amount) === 3000 && r.reference === V1),
    { answer: s1?.answer, warnings: s1?.warnings, rows1, used1 });
  const earned = await prisma.loyaltyEntry.findFirst({ where: { clientId: C, salesOrderId: o1.id, kind: 'EARNED' } as any });
  check('points earned only on the ₹3,000 paid in money (30), not on the voucher', (earned as any)?.points === 30, earned);
  const s1b: any = await applySale(C, store.id, bill('S1', 2, [{ method: 'VOUCHER', amountPaise: 300000, holdId: h1.data.data.holdId, reference: V1 }, { method: 'CASH', amountPaise: 300000 }]) as any);
  check('the same event again: ALREADY_APPLIED, the voucher untouched', s1b?.answer === 'ALREADY_APPLIED' && await balance(V1) === 200000, s1b?.answer);
  const hW = await hold(B, V3, 300000, 300000);
  const s2: any = await applySale(C, store.id, bill('S2', 1, [{ method: 'VOUCHER', amountPaise: 300000, holdId: hW.data.data.holdId, reference: V3 }], null) as any);
  check('a walk-in (no customer) can spend a voucher', s2?.answer === 'APPLIED' && !(s2?.warnings?.length) && await balance(V3) === 100000, { a: s2?.answer, w: s2?.warnings });
  const hx = await hold(A, V2, 200000, 300000), hy = await hold(A, V4, 50000, 300000);
  const s3: any = await applySale(C, store.id, bill('S3', 1, [{ method: 'VOUCHER', amountPaise: 200000, holdId: hx.data.data.holdId, reference: V2 }, { method: 'VOUCHER', amountPaise: 50000, holdId: hy.data.data.holdId, reference: V4 }, { method: 'CASH', amountPaise: 50000 }]) as any);
  check('two vouchers on one bill: both settled', s3?.answer === 'APPLIED' && !(s3?.warnings?.length) && await balance(V2) === 0 && await balance(V4) === 50000, { a: s3?.answer, w: s3?.warnings });
  const s4: any = await applySale(C, store.id, bill('S4', 1, [{ method: 'VOUCHER', amountPaise: 300000, holdId: h1.data.data.holdId, reference: V1 }]) as any);
  check('a hold already used by another bill: applied with a warning, the voucher untouched', s4?.answer === 'APPLIED' && (s4?.warnings ?? []).some((w: string) => /already used by another bill/.test(w)) && await balance(V1) === 200000, { a: s4?.answer, w: s4?.warnings });
  check('a used-up voucher checks as USED_UP', (await A.get(`/vouchers/${V2}`)).data?.data?.status === 'USED_UP');

  console.log('\nR. RETURNS');
  const r1: any = await applyReturn(C, store.id, { kind: 'sale.returned', creditNoteNo: `CN/GV/${STAMP}-R1`, againstInvoiceNo: `INV/GV/${STAMP}-S1`, occurredAt: new Date().toISOString(),
    lines: [{ itemCode: variant.variantCode, qty: 2, lineTotalPaise: PRICE * 2 }], totals: {},
    refunds: [{ method: 'VOUCHER', amountPaise: 300000, reference: V1 }, { method: 'CASH', amountPaise: 300000 }] } as any);
  const back = await prisma.salesOrderPayment.findMany({ where: { clientId: C, salesOrderId: o1.id, kind: 'REFUND' }, select: { method: true, amount: true, reference: true } });
  check('a return of a voucher-paid bill: ₹3,000 back onto the voucher (₹2,000 → ₹5,000), ₹3,000 cash; a VOUCHER refund row naming it',
    r1?.answer === 'APPLIED' && await balance(V1) === 500000 && back.some(r => r.method === 'VOUCHER' && Number(r.amount) === 3000 && r.reference === V1) && back.some(r => r.method === 'CASH' && Number(r.amount) === 3000),
    { a: r1?.answer, w: r1?.warnings, back });
  const s5: any = await applySale(C, store.id, bill('S5', 1, [{ method: 'CASH', amountPaise: 300000 }]) as any);
  const r2: any = await applyReturn(C, store.id, { kind: 'sale.returned', creditNoteNo: `CN/GV/${STAMP}-R2`, againstInvoiceNo: `INV/GV/${STAMP}-S5`, occurredAt: new Date().toISOString(),
    lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: PRICE }], totals: {}, refund: { method: 'VOUCHER', reference: V1 } } as any).catch((e: any) => ({ answer: 'THREW', message: e?.message }));
  check('a bill not paid by voucher cannot refund onto one, and nothing moves', s5?.answer === 'APPLIED' && r2?.answer !== 'APPLIED' && await balance(V1) === 500000, r2);
  // A voucher that expired after the bill: the money returned gets 30 days.
  const hz = await hold(A, V4, 50000, 300000);
  const s6: any = await applySale(C, store.id, bill('S6', 1, [{ method: 'VOUCHER', amountPaise: 50000, holdId: hz.data.data.holdId, reference: V4 }, { method: 'CASH', amountPaise: 250000 }]) as any);
  await prisma.giftVoucher.update({ where: { id: blockedId }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });
  const r3: any = await applyReturn(C, store.id, { kind: 'sale.returned', creditNoteNo: `CN/GV/${STAMP}-R3`, againstInvoiceNo: `INV/GV/${STAMP}-S6`, occurredAt: new Date().toISOString(),
    lines: [{ itemCode: variant.variantCode, qty: 1, lineTotalPaise: PRICE }], totals: {}, refunds: [{ method: 'VOUCHER', amountPaise: 50000 }, { method: 'CASH', amountPaise: 250000 }] } as any);
  const v4 = await prisma.giftVoucher.findUniqueOrThrow({ where: { id: blockedId } });
  check('returned onto a voucher that has since expired: the money is back, and it can be spent for 30 more days',
    s6?.answer === 'APPLIED' && r3?.answer === 'APPLIED' && v4.balancePaise === 50000 && Math.round((v4.expiresAt.getTime() - Date.now()) / 86_400_000) === 30 && (await A.get(`/vouchers/${V4}`)).data?.data?.status === 'ACTIVE',
    { r3: r3?.answer, w: r3?.warnings, bal: v4.balancePaise, exp: v4.expiresAt });

  console.log('\nW. THE SWEEP');
  const hs = await hold(A, V1, 100000, 100000);
  await prisma.posHold.update({ where: { id: hs.data.data.holdId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  check('a reserve never confirmed, past its 10 minutes, no longer holds the balance', await left(V1) === 500000 && (await prisma.posHold.findUniqueOrThrow({ where: { id: hs.data.data.holdId } })).status === 'SWEPT');

  console.log('\nD. THE DAY BOOK');
  const db: any = await dayBookService.getDay(C, new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  check('vouchers used on bills today and returned onto them are in the Gift vouchers section', db.giftVouchers?.used === 3000 + 3000 + 2500 + 500 && db.giftVouchers?.returnedOnto === 3500, db.giftVouchers);
  check('the money section lists voucher payments by name, apart from cash', db.money.taken.VOUCHER?.amount === 9000 && db.money.cashInDrawer === (db.money.taken.CASH?.amount ?? 0) - (db.money.paidBack.CASH?.amount ?? 0) + (db.giftVouchers.soldBy.CASH ?? 0), db.money);
}

(async () => {
  if (!await deployedFirst()) { await prisma.$disconnect(); process.exit(2); }
  await main().catch(e => { failed++; console.error(e); });
  const w = { clientId: C };
  const steps: [string, () => Promise<unknown>][] = [
    ['pos events', () => prisma.posInboundEvent.deleteMany({ where: w })],
    ['holds', () => prisma.posHold.deleteMany({ where: w })],
    ['voucher entries', () => prisma.giftVoucherEntry.deleteMany({ where: w })],
    ['vouchers', () => prisma.giftVoucher.deleteMany({ where: w })],
    ['voucher settings', () => prisma.giftVoucherSettings.deleteMany({ where: w })],
    ['payments', () => prisma.salesOrderPayment.deleteMany({ where: w })],
    ['loyalty', () => prisma.loyaltyEntry.deleteMany({ where: w })],
    ['return items', () => prisma.salesReturnItem.deleteMany({ where: { salesReturn: w } })],
    ['returns', () => prisma.salesReturn.deleteMany({ where: w })],
    ['orders', () => prisma.salesOrder.deleteMany({ where: w })],
    ['quotes', () => prisma.pricingQuote.deleteMany({ where: w })],
    ['transactions', () => prisma.inventoryTransaction.deleteMany({ where: w })],
    ['loyalty settings', () => prisma.loyaltySettings.deleteMany({ where: w })],
    ['customers', () => prisma.customer.deleteMany({ where: w })],
    ['stock', () => prisma.inventoryStock.deleteMany({ where: w })],
    ['variants', () => prisma.productVariant.deleteMany({ where: w })],
    ['products', () => prisma.product.deleteMany({ where: w })],
    ['connections', () => prisma.storefrontConnection.deleteMany({ where: w })],
    ['settings', () => prisma.clientSettings.deleteMany({ where: w })],
    ['locations', () => prisma.stockLocation.deleteMany({ where: w })]
  ];
  const leftover: string[] = [];
  for (const [label, run] of steps) { try { await run(); } catch (e: any) { leftover.push(`${label}: ${String(e.message).split('\n').slice(-1)[0]}`); } }
  console.log(leftover.length ? `\nteardown left behind -- ${leftover.join('; ')}` : '\nthrowaway shop removed');
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})();
