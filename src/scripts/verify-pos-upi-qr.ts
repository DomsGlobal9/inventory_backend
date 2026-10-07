/**
 * UPI QR at the POS till, for real: the local backend, a till key, and sphl's Razorpay TEST keys.
 * Razorpay's own test route (POST /v1/bharatqr/pay/test) plays the customer paying.
 *
 *   A  off by default: the catalogue says so and a QR is refused in words; a shop with no Razorpay
 *      account is refused too
 *   B  switched on: a QR for exactly the bill, its image loads, the same key answers the same QR
 *   C  the customer pays (Razorpay test payment): the till's poll turns PAID with the payment id
 *   D  the webhook path: Razorpay's qr_code.credited parsed and applied the way a delivery is
 *   E  the cashier gives up: close answers CLOSED; closing a PAID one answers PAID
 *
 * Needs: the local backend on :4006 with PAYMENTS_ALLOW_TEST_KEYS=true, and sphl's TEST keys.
 * Touches sphl only through a till key it makes and removes, and the switch it puts back.
 *   npx tsx src/scripts/verify-pos-upi-qr.ts
 */
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { decryptCredential } from '../lib/credentialEncryption';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { paymentAccounts } from '../services/payments/account.service';
import { applyWebhook } from '../services/payments/online-payment.service';

const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const SHOP = 'sphl';
const NO_ACCOUNT = 'pos-e2e-1791196721613';
const STAMP = Date.now();
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const account = await prisma.shopPaymentAccount.findUniqueOrThrow({ where: { clientId: SHOP } });
  if (account.mode !== 'TEST') throw new Error('sphl is not on TEST keys -- this suite never runs against live keys.');
  const wasOn = account.upiQrEnabled;
  const rzp = axios.create({ baseURL: 'https://api.razorpay.com/v1', auth: { username: account.keyId, password: decryptCredential(account.keySecretEncrypted) }, validateStatus: () => true });

  const store = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: SHOP, type: 'STORE' as any, active: true } });
  const till = await posConnectionService.create(SHOP, { locationId: store.id, name: `UPI QR test ${STAMP}` });
  const otherStore = await prisma.stockLocation.findFirst({ where: { clientId: NO_ACCOUNT, type: 'STORE' as any } });
  const otherTill = otherStore ? await posConnectionService.create(NO_ACCOUNT, { locationId: otherStore.id, name: `UPI QR test ${STAMP}` }) : null;
  const A = axios.create({ baseURL: `${API}/pos/v1`, headers: { 'X-Storefront-Key': till.key }, validateStatus: () => true });
  const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 260)}`;
  const pay = (qrId: string, amount: number) => rzp.post('/bharatqr/pay/test', { reference: qrId, amount, method: 'upi' });

  try {
    console.log('\nA. OFF BY DEFAULT');
    await paymentAccounts.setUpiQr(SHOP, false, 'http://localhost');
    const cat0 = await A.get('/catalogue', { params: { limit: 1 } });
    check('the catalogue says UPI QR is off', cat0.data?.data?.upiQr?.enabled === false, JSON.stringify(cat0.data?.data?.upiQr));
    const r0 = await A.post('/upi-qr', { idempotencyKey: `off-${STAMP}`, amountPaise: 1000 });
    check('a QR is refused in words while it is off (NOT_ENABLED)', r0.status === 422 && r0.data?.data?.answer === 'NOT_ENABLED' && /bank QR/.test(r0.data?.data?.detail ?? ''), brief(r0));
    if (otherTill) {
      const r1 = await axios.post(`${API}/pos/v1/upi-qr`, { idempotencyKey: `none-${STAMP}`, amountPaise: 1000 }, { headers: { 'X-Storefront-Key': otherTill.key }, validateStatus: () => true });
      check('a shop with no Razorpay account: NOT_CONNECTED', r1.status === 422 && r1.data?.data?.answer === 'NOT_CONNECTED', brief(r1));
    }

    console.log('\nB. SWITCHED ON');
    await paymentAccounts.setUpiQr(SHOP, true, 'http://localhost');
    const cat1 = await A.get('/catalogue', { params: { limit: 1 } });
    check('the catalogue says UPI QR is on', cat1.data?.data?.upiQr?.enabled === true, JSON.stringify(cat1.data?.data?.upiQr));
    const q1 = await A.post('/upi-qr', { idempotencyKey: `bill-${STAMP}`, amountPaise: 12345, invoiceRef: `TEST/${STAMP}` });
    const qr = q1.data?.data;
    if (q1.status === 503 && q1.data?.data?.answer === 'UNAVAILABLE') {
      check('Razorpay could not be reached: the till is told in plain words to use the bank QR', /bank QR/.test(q1.data?.data?.detail ?? ''), brief(q1));
      console.log('  STOPPED: Razorpay was unreachable just now -- run again.');
      return;
    }
    if (q1.status === 422 && q1.data?.data?.answer === 'QR_NOT_ACTIVATED') {
      check('Razorpay refused: QR Codes is not switched on for this account -- the till gets QR_NOT_ACTIVATED in plain words', /QR Codes is not switched on/.test(q1.data?.data?.detail ?? ''), brief(q1));
      console.log('\n  STOPPED: switch on QR Codes for this Razorpay account (Dashboard, Test mode) to test the rest.');
      return;
    }
    check('a QR for exactly ₹123.45, WAITING, closing in about 15 minutes', q1.status === 200 && /^qr_/.test(qr?.qrId ?? '') && qr.amountPaise === 12345 && qr.status === 'WAITING' && Date.parse(qr.expiresAt) - Date.now() > 14 * 60_000, brief(q1));
    const img = qr?.imageUrl ? await axios.get(qr.imageUrl, { responseType: 'arraybuffer', validateStatus: () => true }) : null;
    check('  ...its picture loads', img?.status === 200 && (img.data?.byteLength ?? 0) > 500, `${img?.status} ${img?.headers?.['content-type']}`);
    const q1b = await A.post('/upi-qr', { idempotencyKey: `bill-${STAMP}`, amountPaise: 12345 });
    check('  ...the same key again answers the same QR, not a second one', q1b.data?.data?.qrId === qr?.qrId, brief(q1b));
    const s0 = await A.get(`/upi-qr/${qr?.qrId}`);
    check('  ...nobody has paid yet: WAITING', s0.data?.data?.status === 'WAITING', brief(s0));

    console.log('\nC. THE CUSTOMER PAYS (Razorpay test payment)');
    const p1 = await pay(qr.qrId, 12345);
    check('Razorpay takes the test payment', p1.status >= 200 && p1.status < 300, `${p1.status} ${JSON.stringify(p1.data).slice(0, 300)}`);
    let s1: any = null;
    for (let i = 0; i < 15; i++) { await sleep(4500); s1 = (await A.get(`/upi-qr/${qr.qrId}`)).data?.data; if (s1?.status !== 'WAITING') break; }
    check('the till\'s poll turns PAID, with the payment id and ₹123.45', s1?.status === 'PAID' && /^pay_/.test(s1?.paymentId ?? '') && s1?.paidPaise === 12345, JSON.stringify(s1));
    const c1 = await A.post(`/upi-qr/${qr.qrId}/close`);
    check('closing a QR that was already paid answers PAID, so the money is taken, not lost', c1.data?.data?.status === 'PAID', brief(c1));

    console.log('\nD. THE WEBHOOK PATH');
    const q2 = (await A.post('/upi-qr', { idempotencyKey: `hook-${STAMP}`, amountPaise: 5000 })).data?.data;
    const p2 = await pay(q2.qrId, 5000);
    const gateway = await paymentAccounts.gatewayFor(SHOP);
    const delivery = JSON.stringify({ event: 'qr_code.credited', payload: { qr_code: { entity: { id: q2.qrId } }, payment: { entity: { id: p2.data?.id ?? 'pay_x', amount: 5000 } } } });
    const ev = gateway!.parseWebhook(delivery, {});
    check('qr_code.credited is read as a QR payment for that QR', ev.kind === 'QR_CREDITED' && ev.qrCodeId === q2.qrId, JSON.stringify(ev));
    let applied = 'IGNORED';
    for (let i = 0; i < 10 && applied !== 'APPLIED'; i++) { await sleep(3000); applied = await applyWebhook(SHOP, gateway!, ev); }
    const row = await prisma.posUpiQr.findUnique({ where: { qrId: q2.qrId } });
    check('  ...applied: the QR is PAID without the till asking (Razorpay is asked again with the shop\'s keys)', applied === 'APPLIED' && row?.status === 'PAID', `${applied} ${row?.status}`);
    const forged = gateway!.parseWebhook(JSON.stringify({ event: 'qr_code.credited', payload: { qr_code: { entity: { id: 'qr_NOTOURSXXXXXXX' } } } }), {});
    check('  ...a delivery about a QR Inventory never made changes nothing', await applyWebhook(SHOP, gateway!, forged) === 'IGNORED');

    console.log('\nE. THE CASHIER GIVES UP');
    const q3 = (await A.post('/upi-qr', { idempotencyKey: `giveup-${STAMP}`, amountPaise: 7000 })).data?.data;
    const c3 = await A.post(`/upi-qr/${q3.qrId}/close`);
    check('an unpaid QR closes: CLOSED', c3.data?.data?.status === 'CLOSED', brief(c3));
    const after = await rzp.get(`/payments/qr_codes/${q3.qrId}`);
    check('  ...and Razorpay closed it too, so it cannot take money any more', after.data?.status === 'closed', `${after.status} ${after.data?.status}`);
    const unknown = await A.get('/upi-qr/qr_NOTOURSXXXXXXX');
    check('a QR Inventory never made: 404', unknown.status === 404 && unknown.data?.data?.answer === 'QR_UNKNOWN', brief(unknown));
  } finally {
    // Always off afterwards: a test must never leave a shop taking QR payments it did not choose.
    await paymentAccounts.setUpiQr(SHOP, false, 'http://localhost').catch(() => undefined);
    await posConnectionService.disconnect(SHOP, till.id).catch(() => undefined);
    if (otherTill) await posConnectionService.disconnect(NO_ACCOUNT, otherTill.id).catch(() => undefined);
    await prisma.posUpiQr.deleteMany({ where: { clientId: SHOP, idempotencyKey: { endsWith: `-${STAMP}` } } }).catch(() => undefined);
    console.log(`\nswitch left off (it was ${wasOn ? 'on' : 'off'}); test till keys removed`);
  }
  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => { console.log('CRASHED:', e?.stack ?? e); await prisma.$disconnect(); process.exit(1); });
