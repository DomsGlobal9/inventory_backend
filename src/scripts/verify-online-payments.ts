/**
 * verify-online-payments.ts -- taking money online, part 1: the gateway adapter and the keys.
 *
 *   npx tsx src/scripts/verify-online-payments.ts
 *
 * PART A needs nothing but this process. A stand-in Razorpay runs on 127.0.0.1 (RAZORPAY_API_URL is
 * set before anything is imported), and the Razorpay adapter is driven against it: keys accepted
 * and refused, orders for our own figure, refunds, a gateway that is down, and every signature --
 * the checkout handback and the webhook -- against known-good and tampered payloads.
 *
 * PART B uses the database: saving a shop's keys, never handing a secret back, one Razorpay account
 * per shop, a new webhook secret, disconnecting. It runs only once the migration
 * 20260929120000_shop_payment_accounts is in the database, and says it skipped otherwise -- the rows
 * it makes belong to throwaway shop ids and are deleted at the end either way.
 *
 * Never a real gateway (PLAN-online-shop-payments.md, "Tests"). The one real check is an owner
 * pressing "Check it works" on their own keys.
 */
import 'dotenv/config';
import http from 'http';
import crypto from 'crypto';
import { AddressInfo } from 'net';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? '  -- ' + detail : ''}`); }
}
const section = (t: string) => console.log(`\n${t}`);

// ── The stand-in Razorpay ────────────────────────────────────────────────────────────────────
const GOOD = { keyId: 'rzp_live_AbCdEf0123456789', keySecret: 'S3cretS3cretS3cretS3cret' };
const TEST = { keyId: 'rzp_test_AbCdEf0123456789', keySecret: 'T3stT3stT3stT3stT3stT3st' };
const fake = {
  mode: 'ok' as 'ok' | 'down' | 'mismatch',
  calls: [] as { method: string; path: string; body: any; auth: string }[],
  orders: 0
};
const accepted = new Set([GOOD, TEST].map((k) => Buffer.from(`${k.keyId}:${k.keySecret}`).toString('base64')));

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const auth = String(req.headers.authorization || '').replace(/^Basic /, '');
    const body = raw ? JSON.parse(raw) : null;
    const path = String(req.url);
    fake.calls.push({ method: String(req.method), path, body, auth });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (fake.mode === 'down') return send(503, { error: { description: 'Service unavailable' } });
    if (!accepted.has(auth)) return send(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
    if (req.method === 'GET' && path.startsWith('/orders?')) return send(200, { entity: 'collection', count: 0, items: [] });
    if (req.method === 'POST' && path === '/orders') {
      if (body.amount < 100) return send(400, { error: { description: 'Order amount less than minimum amount allowed' } });
      return send(200, { id: `order_${++fake.orders}`, amount: fake.mode === 'mismatch' ? body.amount + 1 : body.amount, currency: body.currency, receipt: body.receipt, status: 'created' });
    }
    const refund = path.match(/^\/payments\/([^/]+)\/refund$/);
    if (req.method === 'POST' && refund) return send(200, { id: `rfnd_${refund[1]}`, amount: body.amount, status: body.amount > 500000 ? 'pending' : 'processed' });
    const pays = path.match(/^\/orders\/([^/]+)\/payments$/);
    if (req.method === 'GET' && pays) {
      return send(200, { items: [{ id: 'pay_1', status: 'failed', amount: 850000, error_description: 'Bank declined' }, { id: 'pay_2', status: 'captured', amount: 850000 }] });
    }
    return send(404, { error: { description: 'Not found' } });
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.RAZORPAY_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const g = await import('../services/payments/gateway');
  const { RazorpayGateway, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, razorpayMode, maskKeyId, gatewayFor, GatewayError } = g;
  const WEBHOOK_SECRET = 'whsec-verify-0123456789abcdef';
  const live = new RazorpayGateway(GOOD.keyId, GOOD.keySecret, WEBHOOK_SECRET);
  const secretsIn = (s: string) => [GOOD.keySecret, TEST.keySecret, WEBHOOK_SECRET].some((x) => s.includes(x));

  section('KEYS  (what a Key ID and a Key Secret look like)');
  check('a live and a test key id are recognised', RAZORPAY_KEY_ID.test(GOOD.keyId) && RAZORPAY_KEY_ID.test(TEST.keyId));
  check('junk key ids are not', ['rzp_live_', 'rzp_prod_AbCdEf0123456789', 'AbCdEf0123456789', 'rzp_live_Ab Cd', ''].every((k) => !RAZORPAY_KEY_ID.test(k)));
  check('a secret is 16-64 letters and digits', RAZORPAY_KEY_SECRET.test(GOOD.keySecret) && !RAZORPAY_KEY_SECRET.test('short') && !RAZORPAY_KEY_SECRET.test('has space in it 123456'));
  check('mode comes from the key id', razorpayMode(GOOD.keyId) === 'LIVE' && razorpayMode(TEST.keyId) === 'TEST');
  check('the masked key keeps the kind and the last four', maskKeyId(GOOD.keyId) === 'rzp_live_…6789');

  section('"CHECK IT WORKS"  (keys accepted, test keys caught, wrong keys named, gateway down)');
  let r = await live.check();
  check('live keys: connected, and the message names the key without the secret', r.ok && r.mode === 'LIVE' && r.message.includes('rzp_live_…6789') && !secretsIn(r.message), r.message);
  r = await new RazorpayGateway(TEST.keyId, TEST.keySecret).check();
  check('test keys: accepted, but the owner is told no real money can be paid', r.ok && r.mode === 'TEST' && /TEST keys/.test(r.message), r.message);
  r = await new RazorpayGateway(GOOD.keyId, 'WrongWrongWrongWrong').check();
  check('a wrong secret: not ok, and Razorpay\'s own words', !r.ok && /Authentication failed/.test(r.message), r.message);
  fake.mode = 'down';
  r = await live.check();
  check('Razorpay down: not ok, "try again", never a crash', !r.ok && /Try again/.test(r.message), r.message);
  fake.mode = 'ok';
  check('the check sent basic auth with the shop\'s own pair', fake.calls.at(-1)?.auth === Buffer.from(`${GOOD.keyId}:${GOOD.keySecret}`).toString('base64'));

  section('ORDERS  (our figure, in paise, never the browser\'s)');
  fake.calls.length = 0;
  const order = await live.createOrder(850000, 'SO-000123-a-very-long-receipt-that-goes-past-forty', { shop: 'x' });
  const sent = fake.calls[0]?.body;
  check('the amount sent is exactly the paise asked for, in INR', sent?.amount === 850000 && sent?.currency === 'INR');
  check('the receipt is cut to Razorpay\'s 40 characters', typeof sent?.receipt === 'string' && sent.receipt.length === 40);
  check('the browser gets the key id, the order and the amount -- and no secret',
    order.checkoutPayload.key === GOOD.keyId && order.checkoutPayload.order_id === order.gatewayOrderId && order.checkoutPayload.amount === 850000 && !secretsIn(JSON.stringify(order)));
  let err: any = null;
  fake.calls.length = 0;
  try { await live.createOrder(99, 'r'); } catch (e) { err = e; }
  check('less than ₹1 is refused here, before Razorpay is even asked', err instanceof GatewayError && err.kind === 'BAD_REQUEST' && fake.calls.length === 0);
  err = null;
  try { await live.createOrder(8500.5, 'r'); } catch (e) { err = e; }
  check('fractions of a paisa are refused', err instanceof GatewayError && err.kind === 'BAD_REQUEST');
  fake.mode = 'mismatch'; err = null;
  try { await live.createOrder(850000, 'r'); } catch (e) { err = e; }
  fake.mode = 'ok';
  check('an order that comes back for a different amount is not trusted', err instanceof GatewayError && err.kind === 'UNAVAILABLE');

  section('THE CHECKOUT HANDBACK  (a hint to start looking, verified like proof anyway)');
  const expected = crypto.createHmac('sha256', GOOD.keySecret).update('order_9|pay_7').digest('hex');
  check('a correct signature is accepted', live.verifyCheckoutSignature({ gatewayOrderId: 'order_9', paymentId: 'pay_7', signature: expected }));
  check('in capitals too (some libraries send it that way)', live.verifyCheckoutSignature({ gatewayOrderId: 'order_9', paymentId: 'pay_7', signature: expected.toUpperCase() }));
  check('another payment id with the same signature is refused', !live.verifyCheckoutSignature({ gatewayOrderId: 'order_9', paymentId: 'pay_8', signature: expected }));
  check('another order id is refused', !live.verifyCheckoutSignature({ gatewayOrderId: 'order_1', paymentId: 'pay_7', signature: expected }));
  check('a signature made with another shop\'s secret is refused',
    !live.verifyCheckoutSignature({ gatewayOrderId: 'order_9', paymentId: 'pay_7', signature: crypto.createHmac('sha256', TEST.keySecret).update('order_9|pay_7').digest('hex') }));
  check('empty, short and missing signatures are refused, never thrown',
    ['', 'abc', undefined as any, null as any].every((s) => !live.verifyCheckoutSignature({ gatewayOrderId: 'order_9', paymentId: 'pay_7', signature: s })));

  section('WEBHOOKS  (the only proof a payment happened)');
  const captured = Buffer.from(JSON.stringify({
    entity: 'event', event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_7', order_id: 'order_9', amount: 850000, status: 'captured' } } }
  }));
  const sign = (b: Buffer | string, s = WEBHOOK_SECRET) => crypto.createHmac('sha256', s).update(b).digest('hex');
  check('a correctly signed webhook is accepted', live.verifyWebhook(captured, sign(captured)));
  const tampered = Buffer.from(captured.toString().replace('850000', '850001'));
  check('the same signature on a body with one figure changed is refused', !live.verifyWebhook(tampered, sign(captured)));
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(captured.toString()), null, 1));
  check('the signature is over the raw bytes: the same JSON re-spaced is refused', !live.verifyWebhook(reserialised, sign(captured)));
  check('signed with some other secret: refused', !live.verifyWebhook(captured, sign(captured, 'someone-elses-secret')));
  check('no signature header: refused', !live.verifyWebhook(captured, undefined));
  check('a shop with no webhook secret refuses every webhook', !new RazorpayGateway(GOOD.keyId, GOOD.keySecret).verifyWebhook(captured, sign(captured)));

  let ev = live.parseWebhook(captured, { 'x-razorpay-event-id': 'evt_1' });
  check('payment.captured -> PAID, with the order, the payment, the amount and the delivery id',
    ev.kind === 'PAID' && ev.gatewayOrderId === 'order_9' && ev.paymentId === 'pay_7' && ev.amountPaise === 850000 && ev.eventId === 'evt_1', JSON.stringify(ev));
  ev = live.parseWebhook(JSON.stringify({ event: 'order.paid', payload: { order: { entity: { id: 'order_9', amount_paid: 850000 } }, payment: { entity: { id: 'pay_7', order_id: 'order_9', amount: 850000 } } } }), {});
  check('order.paid -> PAID', ev.kind === 'PAID' && ev.gatewayOrderId === 'order_9' && ev.paymentId === 'pay_7');
  ev = live.parseWebhook(JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_3', order_id: 'order_9', amount: 850000, error_description: 'Payment declined by the bank' } } } }), {});
  check('payment.failed -> FAILED, with the bank\'s words for the owner', ev.kind === 'FAILED' && ev.failReason === 'Payment declined by the bank');
  ev = live.parseWebhook(JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_7', amount: 250000 } } } }), {});
  check('refund.processed -> REFUNDED, the refund and its own amount', ev.kind === 'REFUNDED' && ev.refundId === 'rfnd_1' && ev.paymentId === 'pay_7' && ev.amountPaise === 250000);
  ev = live.parseWebhook(JSON.stringify({ event: 'refund.failed', payload: { refund: { entity: { id: 'rfnd_2', payment_id: 'pay_7', amount: 100 } } } }), {});
  check('refund.failed -> REFUND_FAILED', ev.kind === 'REFUND_FAILED' && ev.refundId === 'rfnd_2');
  ev = live.parseWebhook(JSON.stringify({ event: 'settlement.processed', payload: {} }), {});
  check('anything else is IGNORED, not guessed at', ev.kind === 'IGNORED' && ev.event === 'settlement.processed');
  err = null;
  try { live.parseWebhook('not json', {}); } catch (e) { err = e; }
  check('a body that is not JSON is a BAD_REQUEST, not a crash', err instanceof GatewayError && err.kind === 'BAD_REQUEST');

  section('REFUNDS  (always an explicit amount)');
  fake.calls.length = 0;
  let refund = await live.refund('pay_7', 250000, 'One saree of three returned');
  check('a partial refund sends exactly that amount', fake.calls[0]?.body?.amount === 250000 && fake.calls[0]?.path === '/payments/pay_7/refund');
  check('processed is final', refund.status === 'PROCESSED' && refund.refundId === 'rfnd_pay_7' && refund.amountPaise === 250000);
  refund = await live.refund('pay_7', 850000, 'whole order');
  check('pending is reported as pending, not as done', refund.status === 'PENDING');
  err = null;
  try { await live.refund('pay_7', 0, 'x'); } catch (e) { err = e; }
  check('a zero refund is refused', err instanceof GatewayError && err.kind === 'BAD_REQUEST');
  fake.mode = 'down'; err = null;
  try { await live.refund('pay_7', 100, 'x'); } catch (e) { err = e; }
  fake.mode = 'ok';
  check('Razorpay down during a refund: UNAVAILABLE and marked worth retrying', err instanceof GatewayError && err.kind === 'UNAVAILABLE' && err.transient);
  err = null;
  try { await new RazorpayGateway(GOOD.keyId, 'WrongWrongWrongWrong').refund('pay_7', 100, 'x'); } catch (e) { err = e; }
  check('revoked keys during a refund: AUTH, not retried, secret never in the message', err instanceof GatewayError && err.kind === 'AUTH' && !err.transient && !secretsIn(err.message));

  section('THE SWEEPER\'S QUESTION  (what does Razorpay know about this order?)');
  const pays = await live.paymentsForOrder('order_9');
  check('each attempt with its status, amount and reason',
    pays.length === 2 && pays[0].status === 'FAILED' && pays[0].failReason === 'Bank declined' && pays[1].status === 'CAPTURED' && pays[1].amountPaise === 850000);

  section('ONE SHAPE FOR EVERY GATEWAY');
  const viaFactory = gatewayFor('RAZORPAY', { ...GOOD, webhookSecret: WEBHOOK_SECRET });
  check('gatewayFor(RAZORPAY) is the Razorpay adapter, in the right mode', viaFactory instanceof RazorpayGateway && viaFactory.mode === 'LIVE');
  err = null;
  try { gatewayFor('CASHFREE' as any, GOOD); } catch (e) { err = e; }
  check('a gateway that does not exist yet is an error, not a silent Razorpay', !!err);

  // ── PART B: the shop's keys, in the database ────────────────────────────────────────────
  section('THE SHOP\'S KEYS  (database)');
  const { prisma } = await import('../lib/prisma');
  const exists = await prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.shop_payment_accounts')::text AS t`;
  if (!exists[0]?.t) {
    console.log('  - SKIPPED: the migration 20260929120000_shop_payment_accounts is not in this database yet.');
  } else {
    const { paymentAccounts, testKeysAllowed } = await import('../services/payments/account.service');
    const STAMP = Date.now();
    const A = `paytest-${STAMP}-a`;
    const B = `paytest-${STAMP}-b`;
    const BASE = 'https://api.example.test';
    try {
      let refusal: any = null;
      try { await paymentAccounts.save(A, null, { keyId: 'nope', keySecret: GOOD.keySecret }, BASE); } catch (e) { refusal = e; }
      check('a key id that is not one is refused with where to find it', /API Keys page/.test(refusal?.message || ''));
      const first = await paymentAccounts.save(A, 'user-1', GOOD, BASE);
      check('saving checks at once: connected, live, ready for customers',
        first.account.status === 'CONNECTED' && first.account.mode === 'LIVE' && first.account.readyForCustomers);
      check('the webhook secret is handed over this once, with the address to paste it beside',
        typeof first.webhookSecret === 'string' && first.webhookSecret.length >= 24 && first.account.webhookUrl!.startsWith(`${BASE}/api/v1/payments/webhooks/razorpay/`));
      const described = await paymentAccounts.describe(A, BASE);
      const everything = JSON.stringify(described);
      check('what a browser can read holds no secret of any kind',
        !everything.includes(GOOD.keySecret) && !everything.includes(first.webhookSecret!) && !everything.includes(GOOD.keyId));
      const row = await prisma.shopPaymentAccount.findUnique({ where: { clientId: A } });
      check('the secrets are stored encrypted, not as typed',
        !!row && !row.keySecretEncrypted.includes(GOOD.keySecret) && !row.webhookSecretEncrypted.includes(first.webhookSecret!));

      refusal = null;
      try { await paymentAccounts.save(B, null, GOOD, BASE); } catch (e) { refusal = e; }
      check('another shop pasting the same Razorpay account is refused', /already connected to another shop/.test(refusal?.message || ''));

      const url = first.account.webhookUrl;
      const again = await paymentAccounts.save(A, 'user-1', TEST, BASE);
      check('replacing the keys keeps the webhook address and secret (nothing to re-paste in Razorpay)',
        again.webhookSecret === null && again.account.webhookUrl === url && again.account.mode === 'TEST' &&
        // TEST keys take customers only on a developer's machine that asks for it -- never in production.
        again.account.readyForCustomers === testKeysAllowed());

      const gw = await paymentAccounts.gatewayFor(A);
      const body = Buffer.from('{"event":"payment.captured"}');
      const oldSig = crypto.createHmac('sha256', first.webhookSecret!).update(body).digest('hex');
      check('the stored webhook secret verifies a real signature', !!gw && gw.verifyWebhook(body, oldSig));
      const rotated = await paymentAccounts.newWebhookSecret(A, BASE);
      const gw2 = await paymentAccounts.gatewayFor(A);
      check('a new webhook secret: shown once, the old one stops working at once',
        rotated.webhookSecret !== first.webhookSecret && !!gw2 && !gw2.verifyWebhook(body, oldSig)
        && gw2.verifyWebhook(body, crypto.createHmac('sha256', rotated.webhookSecret).update(body).digest('hex')));

      const byToken = await paymentAccounts.byWebhookToken(url!.split('/').pop()!);
      check('the webhook address finds its shop, and a made-up one finds nothing',
        byToken?.clientId === A && (await paymentAccounts.byWebhookToken('x'.repeat(24))) === null && (await paymentAccounts.byWebhookToken('../../etc')) === null);

      await prisma.shopPaymentAccount.update({ where: { clientId: A }, data: { keySecretEncrypted: (await import('../lib/credentialEncryption')).encryptCredential('WrongWrongWrongWrong') } });
      const failedCheck = await paymentAccounts.check(A, BASE);
      check('keys Razorpay stops accepting: FAILED, in Razorpay\'s words, and not ready', failedCheck.status === 'FAILED' && /Authentication failed/.test(failedCheck.checkMessage || '') && !failedCheck.readyForCustomers);

      const gone = await paymentAccounts.remove(A, BASE);
      check('disconnecting removes the keys outright', !gone.connected && (await paymentAccounts.gatewayFor(A)) === null && !(await prisma.shopPaymentAccount.findUnique({ where: { clientId: A } })));
      check('a shop with nothing connected has no gateway -- never a shared one', (await paymentAccounts.gatewayFor(B)) === null);
    } finally {
      await prisma.shopPaymentAccount.deleteMany({ where: { clientId: { in: [A, B] } } });
    }
  }
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; failures.push(`crashed: ${e?.message || e}`); console.error(e); })
  .finally(() => {
    server.close();
    console.log(`\n${failed ? `FAILED ${failed}: ${failures.join(' | ')}` : `ALL ${passed} CHECKS PASS`}`);
    process.exit(failed ? 1 : 0);
  });
