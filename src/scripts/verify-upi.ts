/**
 * Pay by UPI in the online shop, every case (26 Nov 2026). LOCAL database, a throwaway shop with an online shop.
 * A stand-in Razorpay runs on 127.0.0.1 (never the real one): key check, UPI ID lookup, payment orders.
 *
 *   SETTINGS   a bad UPI ID / name refused in words; Razorpay's way refused without Razorpay; the "Pay by UPI" tick
 *              refused until UPI is set up; every way off refused; with Razorpay, UPI asks whose ID it is (and a
 *              made-up ID is refused); the ways at checkout, UPI first.
 *   DIRECT     placing holds the pieces and tells nobody yet; the page's QR carries the exact amount; a bad reference,
 *              the same reference twice, one reference for two orders; the shop's ONE alert, its count kept; shipping
 *              refused until Payment received; Payment received pressed twice at once = one payment; Not received then
 *              received after all; Not received and a day passes = cancelled, pieces back; no reference in 30 minutes
 *              = cancelled, and a late "I have paid" is refused in words; the customer cancelling; the shop cancelling
 *              (nothing stale left); received on a cancelled order refused; the last piece held by a UPI order;
 *              the shop switching UPI off, or closing, after an order (the shopper can still finish); unknown links.
 *   RAZORPAY   "Pay by UPI" opens Razorpay's window with UPI only; "Pay now" then hides UPI.
 *   HTTP       the shopper's two doors through the real shop address (shop.localhost:4036), open and closed.
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-upi.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';

const fake = { vpaCalls: 0 };
const GOOD = { keyId: 'rzp_live_UpiTest0123456789', keySecret: 'UpiS3cretS3cretS3cret12' };
const auth = Buffer.from(`${GOOD.keyId}:${GOOD.keySecret}`).toString('base64');
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (String(req.headers.authorization || '').replace(/^Basic /, '') !== auth) return send(401, { error: { description: 'Authentication failed' } });
    const body = raw ? JSON.parse(raw) : null;
    const path = String(req.url);
    if (req.method === 'GET' && path.startsWith('/orders?')) return send(200, { entity: 'collection', count: 0, items: [] });
    if (req.method === 'POST' && path === '/orders') return send(200, { id: `order_${crypto.randomBytes(5).toString('hex')}`, amount: body.amount, currency: body.currency, status: 'created' });
    if (req.method === 'POST' && path === '/payments/validate/vpa') {
      fake.vpaCalls++;
      if (body.vpa === 'unchecked@okhdfc') return send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'This feature is not enabled for this merchant.' } });
      return body.vpa === 'nobody@okhdfc' ? send(400, { error: { description: 'Invalid VPA. Please enter a valid Virtual Payment Address' } }) : send(200, { vpa: body.vpa, success: true, customer_name: 'TEST HOLDER' });
    }
    if (req.method === 'GET' && /^\/orders\/[^/]+\/payments/.test(path)) return send(200, { items: [] });
    return send(404, { error: { description: 'Not found' } });
  });
});

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const errOf = async (f: () => Promise<unknown>) => { try { await f(); return null; } catch (e: any) { return e; } };
const plain = (m: string | undefined | null) => !!m && !/HTTP|undefined|null|\{|\}|[A-Z]{3,}_[A-Z]/.test(m);

async function main() {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  process.env.RAZORPAY_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not local.`); process.exit(2); }

  const { prisma } = await import('../lib/prisma');
  const { makeThrowawayShop } = await import('./lib/throwaway-shop');
  const upi = await import('../services/online-shop/upi');
  const checkout = await import('../services/online-shop/checkout');
  const shopSvc = await import('../services/online-shop/shop.service');
  const { paymentAccounts } = await import('../services/payments/account.service');
  const onlinePayments = await import('../services/payments/online-payment.service');
  const { dispatchService } = await import('../services/dispatch.service');
  const { salesOrderService } = await import('../services/sales-order.service');

  const t = await makeThrowawayShop('Upi');
  const { clientId } = t;
  const owner = { id: null, name: 'Owner' };
  try {
    const S = Date.now().toString(36);
    const slug = `upi-${S}`;
    await prisma.onlineShop.upsert({ where: { clientId }, create: { clientId, slug, locationIds: [t.locationId], isLive: true, acceptsOrders: true, payOnDelivery: true } as any, update: { slug, locationIds: [t.locationId], isLive: true, acceptsOrders: true, payOnDelivery: true } as any });
    const p = await prisma.product.create({ data: { clientId, productCode: `UPI-${S}`, slug: `upi-${S}`, title: 'UPI saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any } as any });
    const v = await prisma.productVariant.create({ data: { clientId, productId: p.id, colorName: 'Red', size: 'Free', variantCode: `UPIV-${S}`, sku: `UPIS-${S}`, sellingPrice: 1000 } as any });
    await prisma.inventoryStock.create({ data: { clientId, variantId: v.id, locationId: t.locationId, quantity: 20 } as any });
    const last = await prisma.product.create({ data: { clientId, productCode: `UPL-${S}`, slug: `upl-${S}`, title: 'Last piece', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 500, status: 'ACTIVE' as any } as any });
    const lv = await prisma.productVariant.create({ data: { clientId, productId: last.id, colorName: 'Blue', size: 'Free', variantCode: `UPLV-${S}`, sku: `UPLS-${S}`, sellingPrice: 500 } as any });
    await prisma.inventoryStock.create({ data: { clientId, variantId: lv.id, locationId: t.locationId, quantity: 1 } as any });

    let n = 0;
    const order = (variantCode = v.variantCode, payWay = 'UPI', quantity = 1) => ({
      placementKey: `upi-test-${S}-${++n}-${crypto.randomBytes(6).toString('hex')}`, lines: [{ variantCode, quantity }],
      name: 'Meena Test', phone: `98${String(Date.now() + n).slice(-8)}`, address: '12 Temple Street, Banjara Hills', pincode: '500034', payWay
    });
    const available = async (code: string) => (await shopSvc.oneStoreMax(clientId, [t.locationId], [code])).get(code) ?? 0;
    const alerts = () => prisma.inventoryAlert.findMany({ where: { clientId, title: { startsWith: 'UPI payment' }, isResolved: false } });

    // ── SETTINGS ─────────────────────────────────────────────────────────────────────────────
    console.log('SETTINGS');
    const bad = await errOf(() => upi.saveUpiSettings(clientId, { way: 'DIRECT', upiId: 'not an id', upiName: 'Shop' }));
    ok('a bad UPI ID is refused in words', bad?.statusCode === 400 && /written like name@okhdfc/.test(bad.message), bad?.message);
    const noName = await errOf(() => upi.saveUpiSettings(clientId, { way: 'DIRECT', upiId: 'shop@okhdfc', upiName: 'x' }));
    ok('a name shorter than 2 letters is refused', noName?.statusCode === 400, noName?.message);
    const rzpNo = await errOf(() => upi.saveUpiSettings(clientId, { way: 'RAZORPAY' }));
    ok("Razorpay's way without Razorpay connected is refused in words", rzpNo?.statusCode === 409 && /Connect your Razorpay/.test(rzpNo.message), rzpNo?.message);
    const tickEarly = await errOf(() => shopSvc.save(clientId, { payByUpi: true }));
    ok('the "Pay by UPI" tick is refused until UPI is set up', !!tickEarly && /Add your UPI ID/.test(tickEarly.message), tickEarly?.message);
    const saved = await upi.saveUpiSettings(clientId, { way: 'DIRECT', upiId: 'testshop@okhdfc', upiName: 'Test & Shop?' });
    ok('a good UPI ID is saved; the name loses characters a UPI link cannot carry', saved.upiId === 'testshop@okhdfc' && saved.upiName === 'Test Shop' && saved.ready, saved);
    ok('...and a ₹1 test link is offered', /^upi:\/\/pay\?.*am=1\.00/.test(saved.testLink ?? ''), saved.testLink);
    await shopSvc.save(clientId, { payByUpi: true });
    const allOff = await errOf(() => shopSvc.save(clientId, { acceptsOrders: true, payOnDelivery: false, payOnline: false, payByUpi: false }));
    ok('switching every way to pay off while taking orders is refused', !!allOff && /at least one way/i.test(allOff.message), allOff?.message);
    const ways = (await checkout.orderingFor(clientId))!.payWays;
    ok('at checkout: Pay by UPI first, then cash on delivery (no Pay now without Razorpay)', JSON.stringify(ways) === JSON.stringify(['UPI', 'ON_DELIVERY']), ways);
    const pub = await shopSvc.publicShop(slug) as any;
    ok('the shop page offers the same ways, and says the way is DIRECT', JSON.stringify(pub.buying.payWays) === JSON.stringify(['UPI', 'ON_DELIVERY']) && pub.buying.upiWay === 'DIRECT', pub.buying);

    // ── DIRECT ───────────────────────────────────────────────────────────────────────────────
    console.log('');
    console.log('STRAIGHT TO THE UPI ID');
    const before = await available(v.variantCode);
    const o1 = await checkout.place(clientId, order()) as any;
    const c1 = await prisma.upiClaim.findFirst({ where: { orderToken: o1.token } });
    ok('placing: an order with its UPI claim, AWAITING, for 30 minutes', o1.upi === true && c1?.status === 'AWAITING' && Math.abs(c1.expiresAt.getTime() - Date.now() - 30 * 60_000) < 60_000, { upi: o1.upi, c1 });
    ok('...its pieces are held at once', (await available(v.variantCode)) === before - 1);
    ok('...stored as paid now (not on delivery), not yet paid', o1.payWay === 'ONLINE' && o1.paid === false, { payWay: o1.payWay, paid: o1.paid });
    await new Promise(r => setTimeout(r, 400));
    ok('...nobody is told yet (no "New online order", no UPI alert)', (await prisma.inventoryAlert.count({ where: { clientId, title: { contains: o1.orderNumber } } })) === 0 && (await alerts()).length === 0);
    const page1 = await upi.forShopper(clientId, o1.token);
    ok("the shopper's page: the exact amount, the shop's UPI ID and name, the order to match", page1.state === 'AWAITING' && page1.amount === o1.total && /pa=testshop%40okhdfc/.test(page1.link) && /am=1000\.00/.test(page1.link) && page1.link.includes(`tr=${o1.orderNumber}`), page1);
    const u1 = '123456789012', u2 = '210987654321';
    for (const [badUtr, why] of [['12345', 'too short'], ['12345678901a', 'a letter'], ['', 'empty'], ['1234567890123', '13 digits']] as const) {
      const e = await errOf(() => upi.iHavePaid(clientId, o1.token, badUtr));
      ok(`a reference that is ${why} is refused in words`, !!e && /12-digit/.test(e.message) && plain(e.message), e?.message);
    }
    const r1 = await upi.iHavePaid(clientId, o1.token, '1234 5678 9012');
    ok('"I have paid" with spaces in the reference: TO_CHECK', r1.state === 'TO_CHECK' && r1.utr === u1, r1);
    await new Promise(r => setTimeout(r, 600));
    let al = await alerts();
    ok("now the shop is told: ONE alert, \"UPI payment to check\"", al.length === 1 && al[0].title === 'UPI payment to check', al.map(a => a.title));
    ok("...but NOT yet the new-order notice, nor the customer's confirmation (they wait for Payment received)", (await prisma.inventoryAlert.count({ where: { clientId, title: { contains: o1.orderNumber } } })) === 0);
    await upi.iHavePaid(clientId, o1.token, u1);
    ok('the same press twice changes nothing (still one alert)', (await alerts()).length === 1);
    const o2 = await checkout.place(clientId, order()) as any;
    const dupe = await errOf(() => upi.iHavePaid(clientId, o2.token, u1));
    ok('one reference for two orders is refused in words', !!dupe && /already given for another order/.test(dupe.message), dupe?.message);
    await upi.iHavePaid(clientId, o2.token, u2);
    await new Promise(r => setTimeout(r, 400));
    al = await alerts();
    ok('a second payment to check: still ONE alert, its count "(2)"', al.length === 1 && al[0].title === 'UPI payments to check (2)', al.map(a => a.title));

    const items1 = await prisma.salesOrderItem.findMany({ where: { salesOrderId: c1!.salesOrderId }, select: { id: true, quantity: true } });
    const ship = (soId: string, its: { id: string; quantity: number }[]) => prisma.$transaction(tx => dispatchService.dispatchInTransaction(tx, clientId, soId, its.map(i => ({ salesOrderItemId: i.id, quantity: i.quantity }))), { timeout: 30000 });
    const blocked = await errOf(() => ship(c1!.salesOrderId, items1));
    ok('sending the order out is refused until the payment is received, in words', blocked?.statusCode === 409 && /not confirmed yet/.test(blocked.message), blocked?.message);

    await Promise.all([upi.received(clientId, owner, c1!.id), upi.received(clientId, owner, c1!.id)]);
    const pays = await prisma.salesOrderPayment.findMany({ where: { salesOrderId: c1!.salesOrderId } });
    ok('Payment received pressed twice at once: ONE payment, UPI, with its reference', pays.length === 1 && pays[0].method === 'UPI' && pays[0].reference === `UPI ${u1}` && Number(pays[0].amount) === o1.total, pays.map(x => [x.method, x.reference, Number(x.amount)]));
    await new Promise(r => setTimeout(r, 600));
    ok("Payment received: NOW the shop gets its new-order notice, once (the customer's confirmation goes with it)", (await prisma.inventoryAlert.count({ where: { clientId, title: { contains: o1.orderNumber } } })) === 1);
    const s1 = await checkout.summary(clientId, o1.token) as any;
    ok("the shopper's order page: paid", s1.paid === true && s1.upi?.state === 'RECEIVED', { paid: s1.paid, upi: s1.upi });
    await new Promise(r => setTimeout(r, 400));
    al = await alerts();
    ok('the alert counts down to the one left', al.length === 1 && al[0].title === 'UPI payment to check', al.map(a => a.title));
    const sent = await errOf(() => ship(c1!.salesOrderId, items1));
    ok('now it can be sent out', sent === null, sent?.message);

    const c2 = await prisma.upiClaim.findFirst({ where: { orderToken: o2.token } });
    await upi.notReceived(clientId, owner, c2!.id);
    const c2n = await prisma.upiClaim.findUnique({ where: { id: c2!.id } });
    ok('Not received: held a day, the customer asked', c2n?.status === 'NOT_RECEIVED' && Math.abs(c2n.expiresAt.getTime() - Date.now() - 24 * 3600_000) < 120_000, c2n);
    const listed = (await upi.toCheck(clientId)).find(x => x.id === c2!.id);
    ok("...still on the owner's list (as not found)", listed?.status === 'NOT_RECEIVED');
    await upi.received(clientId, owner, c2!.id);
    ok('...and the money turned up after all: Payment received still works', (await prisma.upiClaim.findUnique({ where: { id: c2!.id } }))?.status === 'RECEIVED');
    await new Promise(r => setTimeout(r, 400));
    ok('no payment left to check: the alert is closed', (await alerts()).length === 0);

    const o3 = await checkout.place(clientId, order()) as any;
    await upi.iHavePaid(clientId, o3.token, '333344445555');
    const c3 = await prisma.upiClaim.findFirst({ where: { orderToken: o3.token } });
    await upi.notReceived(clientId, owner, c3!.id);
    const held3 = await available(v.variantCode);
    await upi.sweep(new Date(Date.now() + 25 * 3600_000), [clientId]);
    const so3 = await prisma.salesOrder.findUnique({ where: { id: c3!.salesOrderId }, select: { status: true } });
    ok('Not received and a day passes: the order is cancelled', so3?.status === 'CANCELLED' && (await prisma.upiClaim.findUnique({ where: { id: c3!.id } }))?.status === 'CANCELLED');
    ok('...its piece back on sale', (await available(v.variantCode)) === held3 + 1);
    const late3 = await errOf(() => upi.received(clientId, owner, c3!.id));
    ok('Payment received on a cancelled order is refused in words', late3?.statusCode === 409 && /cancelled/.test(late3.message), late3?.message);

    const o4 = await checkout.place(clientId, order()) as any;
    const held4 = await available(v.variantCode);
    await upi.sweep(new Date(Date.now() + 31 * 60_000), [clientId]);
    const c4 = await prisma.upiClaim.findFirst({ where: { orderToken: o4.token } });
    const so4 = await prisma.salesOrder.findUnique({ where: { id: c4!.salesOrderId }, select: { status: true } });
    ok('no reference in 30 minutes: EXPIRED, order cancelled, piece back', c4?.status === 'EXPIRED' && so4?.status === 'CANCELLED' && (await available(v.variantCode)) === held4 + 1, { c4: c4?.status, so4 });
    const late4 = await errOf(() => upi.iHavePaid(clientId, o4.token, '444455556666'));
    ok('...a late "I have paid" is refused in words, pointing at the shop', !!late4 && /cancelled before a payment reference arrived/.test(late4.message), late4?.message);
    ok("...the shopper's page says it was not completed", (await upi.forShopper(clientId, o4.token)).state === 'EXPIRED');

    // The 30 minutes hold even when the timer has not run: the page itself sees the time is up.
    const o4b = await checkout.place(clientId, order()) as any;
    await prisma.upiClaim.updateMany({ where: { orderToken: o4b.token }, data: { expiresAt: new Date(Date.now() - 1000) } });
    ok('time up but the timer has not run: the page itself settles it (EXPIRED)', (await upi.forShopper(clientId, o4b.token)).state === 'EXPIRED');

    const o5 = await checkout.place(clientId, order()) as any;
    await upi.iHavePaid(clientId, o5.token, '555566667777');
    await checkout.cancel(clientId, o5.token);
    await new Promise(r => setTimeout(r, 400));
    ok('the customer cancels their UPI order: claim CANCELLED, no alert left', (await prisma.upiClaim.findFirst({ where: { orderToken: o5.token } }))?.status === 'CANCELLED' && (await alerts()).length === 0);

    const o6 = await checkout.place(clientId, order()) as any;
    await upi.iHavePaid(clientId, o6.token, '666677778888');
    const c6 = await prisma.upiClaim.findFirst({ where: { orderToken: o6.token } });
    await salesOrderService.cancelOrder(clientId, c6!.salesOrderId);
    ok("the shop cancels it from Orders: gone from the owner's list (nothing stale)", !(await upi.toCheck(clientId)).some(x => x.id === c6!.id));
    await upi.refreshShopAlert(clientId);
    ok('...and from the alert', (await alerts()).length === 0);

    // The last piece: held by a UPI order, nobody else can have it.
    const oLast = await checkout.place(clientId, order(lv.variantCode)) as any;
    ok('the last piece is held by the UPI order', (await available(lv.variantCode)) === 0 && !!oLast.token);
    const second = await errOf(() => checkout.place(clientId, order(lv.variantCode)));
    ok('...a second shopper cannot order it (refused in words)', !!second && /not available|bought by someone else|sold out/i.test(second.message), second?.message);

    // The shop changes its mind after an order: the shopper can still finish.
    const o7 = await checkout.place(clientId, order()) as any;
    await shopSvc.save(clientId, { payByUpi: false });
    await upi.saveUpiSettings(clientId, { way: 'DIRECT', upiId: 'newshop@okicici', upiName: 'New Name' });
    const p7 = await upi.forShopper(clientId, o7.token);
    ok('UPI switched off and the UPI ID changed after an order: its page still pays the ID it was placed with', p7.state === 'AWAITING' && /pa=testshop%40okhdfc/.test(p7.link), p7.link);
    ok('...and "I have paid" still works', (await upi.iHavePaid(clientId, o7.token, '777788889999')).state === 'TO_CHECK');
    const nope = await errOf(() => upi.forShopper(clientId, 'no-such-token'));
    ok('an unknown link: "That payment could not be found."', nope?.message === 'That payment could not be found.');

    // ── PAY ANOTHER WAY (the QR page's back button) ─────────────────────────────────────────────
    console.log('');
    console.log('PAY ANOTHER WAY');
    await shopSvc.save(clientId, { payByUpi: true });   // the test above switched it off
    const heldB = await available(v.variantCode);
    const alertsBefore = (await alerts()).map(x => x.title).join('|');   // another order is still waiting to be checked
    const b1 = await checkout.place(clientId, order()) as any;
    ok('a UPI order holds its piece', (await available(v.variantCode)) === heldB - 1);
    const rb1 = await upi.payAnotherWay(clientId, b1.token);
    const cb1 = await prisma.upiClaim.findFirst({ where: { orderToken: b1.token } });
    const sob1 = await prisma.salesOrder.findUnique({ where: { id: cb1!.salesOrderId }, select: { status: true } });
    ok('before any reference: the order is let go (claim CANCELLED, order CANCELLED)', rb1.released === true && cb1?.status === 'CANCELLED' && sob1?.status === 'CANCELLED', { claim: cb1?.status, order: sob1?.status });
    ok('...its piece is back on sale at once', (await available(v.variantCode)) === heldB);
    await new Promise(r => setTimeout(r, 500));
    const alertsAfter = (await alerts()).map(x => x.title).join('|');
    ok('...quietly: no alert about it for the shop, the UPI alert unchanged', (await prisma.inventoryAlert.count({ where: { clientId, title: { contains: b1.orderNumber } } })) === 0 && alertsAfter === alertsBefore, { alertsBefore, alertsAfter });
    ok('pressed again (a double tap, a second tab): the same answer, nothing more', (await upi.payAnotherWay(clientId, b1.token)).released === true);
    const lateB = await errOf(() => upi.iHavePaid(clientId, b1.token, '818181818181'));
    ok('a reference typed after going back is refused in words (pointing at the shop)', !!lateB && /cancelled before a payment reference arrived/.test(lateB.message), lateB?.message);
    ok("the shopper's page for it says not completed", (await upi.forShopper(clientId, b1.token)).state === 'CANCELLED');

    const b2 = await checkout.place(clientId, order()) as any;
    await upi.iHavePaid(clientId, b2.token, '828282828282');
    const rb2 = await errOf(() => upi.payAnotherWay(clientId, b2.token));
    ok('after "I have paid": refused (the money may have left), in words', !!rb2 && /already given a UPI reference/.test(rb2.message) && plain(rb2.message), rb2?.message);
    ok('...the order stays with the shop to check', (await prisma.upiClaim.findFirst({ where: { orderToken: b2.token } }))?.status === 'TO_CHECK');

    const b3 = await checkout.place(clientId, order()) as any;
    const cb3 = await prisma.upiClaim.findFirst({ where: { orderToken: b3.token } });
    await upi.received(clientId, owner, cb3!.id);
    const rb3 = await errOf(() => upi.payAnotherWay(clientId, b3.token));
    ok('the shop already marked it received (no reference given): refused, saying it is paid', !!rb3 && /already received your payment/.test(rb3.message), rb3?.message);

    // The same moment: "Pay another way" on one tab, the reference on another. Exactly one may win.
    const b4 = await checkout.place(clientId, order()) as any;
    const [ra, rp] = await Promise.all([errOf(() => upi.payAnotherWay(clientId, b4.token)), errOf(() => upi.iHavePaid(clientId, b4.token, '848484848484'))]);
    const cb4 = await prisma.upiClaim.findFirst({ where: { orderToken: b4.token } });
    const oneWon = (cb4?.status === 'CANCELLED' && !ra && !!rp) || (cb4?.status === 'TO_CHECK' && !!ra && !rp);
    ok('"Pay another way" and "I have paid" at the same moment: exactly one goes through', oneWon, { claim: cb4?.status, wayRefused: ra?.message, paidRefused: rp?.message });
    if (cb4?.status === 'TO_CHECK') await checkout.cancel(clientId, b4.token);

    // The shop presses Payment received while the shopper is still typing the reference: it stays received, paid once.
    const b7 = await checkout.place(clientId, order()) as any;
    const cb7 = await prisma.upiClaim.findFirst({ where: { orderToken: b7.token } });
    const [, paidB7] = await Promise.all([upi.received(clientId, owner, cb7!.id), errOf(() => upi.iHavePaid(clientId, b7.token, '878787878787'))]);
    const cb7n = await prisma.upiClaim.findUnique({ where: { id: cb7!.id } });
    const pays7 = await prisma.salesOrderPayment.count({ where: { salesOrderId: cb7!.salesOrderId } });
    ok('Payment received and "I have paid" at the same moment: stays RECEIVED, ONE payment, the shopper not refused', cb7n?.status === 'RECEIVED' && pays7 === 1 && !paidB7, { status: cb7n?.status, pays7, refused: paidB7?.message });

    const b5 = await checkout.place(clientId, order()) as any;
    await upi.sweep(new Date(Date.now() + 31 * 60_000), [clientId]);
    ok('time already up: going back just answers released (nothing to undo)', (await upi.payAnotherWay(clientId, b5.token)).released === true);
    const noneB = await errOf(() => upi.payAnotherWay(clientId, 'no-such-token'));
    ok('an unknown link: "That payment could not be found."', noneB?.message === 'That payment could not be found.');
    const b6 = await checkout.place(clientId, order()) as any;

    // ── HTTP, through the shop's own address ─────────────────────────────────────────────────
    console.log('');
    console.log('THE SHOP ADDRESS');
    // Straight to the server, naming the shop's own host the way a browser does (Node cannot look up shop.localhost).
    const base = `/_api/shop/${slug}/upi/${o7.token}`;
    const call = (path: string, body?: unknown) => new Promise<any>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: 4036, path, method: body ? 'POST' : 'GET', headers: { host: 'shop.localhost:4036', 'content-type': 'application/json' } }, (res) => {
        let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw: raw.slice(0, 200), status: res.statusCode }); } });
      });
      req.on('error', (e) => resolve({ error: e.message }));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
    const g = await call(base);
    ok('the UPI page door answers through the shop address', (g?.data ?? g)?.state === 'TO_CHECK', g);
    await prisma.onlineShop.update({ where: { clientId }, data: { isLive: false } });
    const gc = await call(base);
    ok('...even with the shop closed (a shopper who already paid can still see it)', (gc?.data ?? gc)?.state === 'TO_CHECK', gc);
    const postBad = await call(`${base}/paid`, { utr: '12' });
    ok('a bad reference through the door: refused in words', /12-digit/.test(postBad?.message ?? ''), postBad);
    const changeRefused = await call(`${base}/change`, {});
    ok('"Pay another way" through the door after a reference: refused in words', /already given a UPI reference/.test(changeRefused?.message ?? ''), changeRefused);
    const changed = await call(`/_api/shop/${slug}/upi/${b6.token}/change`, {});
    ok('"Pay another way" through the door before one (shop closed too): released', (changed?.data ?? changed)?.released === true, changed);
    await prisma.onlineShop.update({ where: { clientId }, data: { isLive: true } });

    // ── RAZORPAY ─────────────────────────────────────────────────────────────────────────────
    console.log('');
    console.log('THROUGH RAZORPAY');
    await paymentAccounts.save(clientId, null, GOOD, 'http://localhost:4036/api/v1');
    const nobody = await errOf(() => upi.saveUpiSettings(clientId, { way: 'DIRECT', upiId: 'nobody@okhdfc', upiName: 'Test Shop' }));
    ok('with Razorpay connected, a UPI ID UPI does not know is refused', nobody?.statusCode === 400 && /UPI does not know nobody@okhdfc/.test(nobody.message), nobody?.message);
    const named = await upi.saveUpiSettings(clientId, { way: 'DIRECT', upiId: 'testshop@okhdfc', upiName: 'Test Shop' });
    ok("...and a real one comes back with its holder's name", named.holder === 'TEST HOLDER', named.holder);
    // Razorpay refusing the CHECK (not the ID) -- as it did live for SPHL on 26 Nov -- must not turn away a real ID.
    const unchecked = await errOf(() => upi.saveUpiSettings(clientId, { way: 'DIRECT', upiId: 'unchecked@okhdfc', upiName: 'Test Shop' }));
    ok('Razorpay not answering the check ("not enabled"): the ID is saved anyway, no holder name', !unchecked, unchecked?.message);
    const afterUnchecked = await upi.upiSettings(clientId);
    ok('...and it is the one stored', afterUnchecked.upiId === 'unchecked@okhdfc', afterUnchecked.upiId);
    await upi.saveUpiSettings(clientId, { way: 'DIRECT', upiId: 'testshop@okhdfc', upiName: 'Test Shop' });
    await upi.saveUpiSettings(clientId, { way: 'RAZORPAY' });
    await shopSvc.save(clientId, { payByUpi: true, payOnline: true });
    const w2 = (await checkout.orderingFor(clientId))!;
    ok('UPI through Razorpay: Pay by UPI, cash on delivery, Pay now', JSON.stringify(w2.payWays) === JSON.stringify(['UPI', 'ON_DELIVERY', 'ONLINE']) && w2.upiWay === 'RAZORPAY', w2.payWays);
    const placeRzp = await errOf(() => checkout.place(clientId, order()));
    ok('placing "Pay by UPI" directly is refused: it goes through the payment page', !!placeRzp && /payment page/.test(placeRzp.message), placeRzp?.message);
    const st = await onlinePayments.start(clientId, 'Test Shop', null, order()) as any;
    const disp = st?.checkout?.config?.display;
    ok("\"Pay by UPI\": Razorpay's window shows UPI only", st.state === 'PAY' && disp?.preferences?.show_default_blocks === false && JSON.stringify(disp?.sequence) === JSON.stringify(['block.upi']), disp);
    const st2 = await onlinePayments.start(clientId, 'Test Shop', null, order(v.variantCode, 'ONLINE')) as any;
    ok('"Pay now" with UPI also offered: the window hides UPI (card, net banking)', JSON.stringify(st2?.checkout?.config?.display?.hide) === JSON.stringify([{ method: 'upi' }]), st2?.checkout?.config?.display);
    await shopSvc.save(clientId, { payOnline: false });
    const st3 = await errOf(() => onlinePayments.start(clientId, 'Test Shop', null, order(v.variantCode, 'ONLINE')));
    ok('"Pay now" switched off: refused even though Razorpay is connected', !!st3 && /cannot take payment online/.test(st3.message), st3?.message);
  } finally {
    await prisma.onlinePaymentHold.deleteMany({ where: { onlinePayment: { clientId } } }).catch(() => undefined);
    await t.remove();
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  const { prisma: pz } = await import('../lib/prisma');
  await pz.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); server.close(); process.exit(1); });
