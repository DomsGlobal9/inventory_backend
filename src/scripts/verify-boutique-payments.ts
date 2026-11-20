/**
 * Boutique payments (20 Nov 2026), against the REAL local server and database: money for boutique work through the
 * shop's own Razorpay. Proved here: who may ask and refund, every refusal in words before Razorpay is asked, a shop
 * without Razorpay told how to connect it, the list and one payment, another shop kept apart, and Razorpay's webhook
 * leaving what is not a boutique payment alone.
 *
 * NOT proved here: the round trip with Razorpay itself (checkout / UPI QR created, paid, captured, refunded). This
 * machine has no Razorpay TEST keys connected to a local shop, and nothing fakes Razorpay. Connect rzp_test_ keys on a
 * local shop (Settings -> Payments, with PAYMENTS_ALLOW_TEST_KEYS=true) and run with RAZORPAY_TEST_SHOP=<clientId> to
 * add those checks.
 *
 * Throwaway accounts only (paytest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-payments.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import * as btqPay from '../services/boutique/payments';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `paytest-${S}`, TEN2 = `paytest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const ALL = ['payments:take', 'payments:refund'];
const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[] } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can ?? ALL)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `pay-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const good1 = { amount: 1500, purpose: 'Blouse stitching advance', reference: 'ST-101', customer: { name: 'Asha', phone: '+91 98480 12399' }, method: 'UPI_QR', minutes: 30 };

async function main() {
  const link = await call('POST', '/link', { shopName: 'Payments Test' });
  const clientId = link.data.clientId as string;
  const link2 = await call('POST', '/link', { shopName: 'Other' }, { tenant: TEN2 });

  console.log('\nWHO MAY');
  check('asking without payments:take: 403', (await call('POST', '/payments', good1, { can: ['products:write'] })).status === 403);
  check('refunding without payments:refund: 403', (await call('POST', '/payments/x/refund', { amount: 1 }, { can: ['payments:take'] })).status === 403);

  console.log('\nREFUSED IN WORDS, BEFORE RAZORPAY IS ASKED');
  for (const [body, why, re] of [
    [{ ...good1, amount: 0 }, 'amount 0', /1 to 50,00,000/], [{ ...good1, amount: 0.5 }, 'amount below Rs 1', /1 to 50,00,000/],
    [{ ...good1, amount: 10.005 }, 'amount with 3 decimals', /2 decimals/], [{ ...good1, amount: 60_00_000 }, 'amount above Rs 50 lakh', /50,00,000/],
    [{ ...good1, purpose: '' }, 'no purpose', /what it is for/], [{ ...good1, reference: '' }, 'no reference', /reference/],
    [{ ...good1, method: 'CASH' }, 'a method that is not one', /CHECKOUT|UPI_QR/], [{ ...good1, minutes: 3 }, 'a QR open 3 minutes', /5 to 120/]
  ] as const) {
    const r = await call('POST', '/payments', body);
    check(`${why}: 400 saying so`, r.status === 400 && (re as RegExp).test(r.message ?? ''), r);
  }

  console.log('\nA SHOP WITHOUT RAZORPAY');
  const noKeys = await call('POST', '/payments', good1);
  check('asking: 409, telling how to connect it (PUT /settings/payments)', noKeys.status === 409 && /settings\/payments/.test(noKeys.message ?? ''), noKeys);
  check('...and nothing was written', !(await prisma.boutiquePayment.count({ where: { clientId } })));

  console.log('\nTHE LIST, ONE PAYMENT, ANOTHER SHOP');
  // A payment as Razorpay would have left it (written here because this machine cannot reach Razorpay with test keys).
  const row = await prisma.boutiquePayment.create({ data: { clientId, reference: 'ST-102', purpose: 'Alteration', amountPaise: 45000, method: 'UPI_QR', status: 'PAID', paidPaise: 45000, paymentId: 'pay_test', paidAt: new Date(), customerName: 'Latha', createdBy: 'Lakshmi (Boutique)' } });
  const list = await call('GET', '/payments', undefined, { can: [] });
  check('listed for anyone of the boutique: Rs 450, PAID, by reference', list.status === 200 && list.data?.total === 1 && list.data.payments[0].amount === 450 && list.data.payments[0].status === 'PAID', list.data);
  check('filtered by reference', (await call('GET', '/payments?reference=ST-102')).data?.total === 1 && (await call('GET', '/payments?reference=NOPE')).data?.total === 0);
  const one = await call('GET', `/payments/${row.id}`);
  check('one payment: purpose, customer, who asked', one.data?.purpose === 'Alteration' && one.data?.customer?.name === 'Latha' && one.data?.askedBy === 'Lakshmi (Boutique)', one.data);
  check('another shop: 404 for it, and not in its list', link2.status === 201 && (await call('GET', `/payments/${row.id}`, undefined, { tenant: TEN2 })).status === 404 && (await call('GET', '/payments', undefined, { tenant: TEN2 })).data?.total === 0);
  const already = await call('POST', `/payments/${row.id}/cancel`, {});
  check('cancelling a paid one: 409, refund it instead', already.status === 409 && /Refund it instead/.test(already.message ?? ''), already);
  const tooMuch = await call('POST', `/payments/${row.id}/refund`, { amount: 500 });
  check('refunding more than was paid: 400 naming what is left (Rs 450)', tooMuch.status === 400 && /450/.test(tooMuch.message ?? ''), tooMuch);
  const noRzp = await call('POST', `/payments/${row.id}/refund`, { amount: 100 });
  check('refunding where Razorpay is not connected: 409 in words', noRzp.status === 409 && /not set up/.test(noRzp.message ?? ''), noRzp);
  const waiting = await prisma.boutiquePayment.create({ data: { clientId, reference: 'ST-103', purpose: 'Advance', amountPaise: 10000, method: 'CHECKOUT', gatewayOrderId: `order_${S}`, createdBy: 'x' } });
  check('refunding a payment still waiting: 409', (await call('POST', `/payments/${waiting.id}/refund`, { amount: 10 })).status === 409);

  console.log('\nRAZORPAY\'S WEBHOOK');
  check('a QR that is no boutique payment\'s: left alone', (await btqPay.onQrCredited(clientId, 'qr_nobody')) === 'IGNORED');
  check('an order that is no boutique payment\'s: left alone', (await btqPay.onOrderPaid(clientId, 'order_nobody')) === 'IGNORED');
  check('another shop\'s webhook naming this shop\'s order: left alone', (await btqPay.onOrderPaid(link2.data.clientId, `order_${S}`)) === 'IGNORED');
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'paytest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  await prisma.boutiquePayment.deleteMany({ where: { clientId: { in: ids } } });
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} clients`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
