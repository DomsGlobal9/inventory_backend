/**
 * "Sign in with WhatsApp" for the online shop (29 Oct): the shopper's account, worst cases first.
 *
 * Over HTTP through the REAL shop routes (mounted here, as verify-tryon-number does), with a stand-in
 * only for what would reach the outside world: the WhatsApp service, which answers "connected" and
 * captures each code instead of messaging anybody. Two throwaway shops, removed at the end.
 *   1. signing in: codes, wrong codes, made-up and other shops' secrets, nothing stored in the clear;
 *   2. two phones, sign out of one, of all, the 10-phone cap, a sign-in that ran out;
 *   3. the checkout: a guest proving their number is signed in; signed in, no code; another number is
 *      not proved by somebody else's sign-in; orders a stranger placed on this number are not shown;
 *   4. points (only with loyalty on) and store credit (only when held);
 *   5. the wishlist: signed out refused, sold out, off sale and back, removed, kept past 30 days;
 *   6. saved addresses, and signing out everywhere closes them;
 *   7. the shop closed; the customer deleted in Inventory signs them out.
 *
 * LOCAL DATABASE ONLY.
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory DIRECT_URL=<same> npx tsx src/scripts/verify-shop-account.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
// The routes' own per-caller limits would stop a test making dozens of codes from one address.
process.env.RATE_LIMIT_MAX = '5000';
import http from 'node:http';
import { AddressInfo } from 'node:net';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 400)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const STAMP = Date.now();
const A = `acct-a-${STAMP}`, B = `acct-b-${STAMP}`;
const SLUG_A = `acct-a-${STAMP}`, SLUG_B = `acct-b-${STAMP}`;
// Made-up numbers; the stand-in never sends anything.
const P1 = '9000011111', P2 = '9000022222', P3 = '9000033333';
const plus = (p: string) => `+91${p}`;

const serve = (handler: (req: http.IncomingMessage, body: any) => [number, unknown]) =>
  new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const [status, out] = handler(req, (() => { try { return JSON.parse(raw); } catch { return null; } })());
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise(r => server.close(() => r())) }));
  });

(async () => {
  const messages: { clientId: string; to: string; text: string }[] = [];
  const wa = await serve((req, body) => {
    if (req.method === 'GET' && /^\/v1\/accounts\/client\//.test(req.url || '')) return [200, { status: 'CONNECTED' }];
    if (req.method === 'POST' && req.url === '/v1/messages') {
      messages.push({ clientId: body?.from?.clientId, to: body?.to, text: body?.text });
      return [200, { id: `msg-${messages.length}-${STAMP}`, status: 'SENT' }];
    }
    return [404, { message: 'not in the stand-in' }];
  });
  process.env.WHATSAPP_SERVICE_URL = wa.url;
  process.env.WHATSAPP_SERVICE_KEY = 'local-stand-in-key';

  const express = (await import('express')).default;
  const { prisma } = await import('../lib/prisma');
  const shopRoutes = (await import('../routes/shop-public.routes')).default;
  const { forgetOldViews } = await import('../services/shop-views');
  const customerDelete = await import('../services/customer-delete');
  const { platformAdminService } = await import('../services/platform-admin.service');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/shop', shopRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile') =>
    fetch(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const lastCode = () => /(\d{6}) is your code/.exec(messages[messages.length - 1]?.text ?? '')?.[1] ?? '';

  const sa = (p: string) => `/shop/${SLUG_A}${p}`;
  /** Prove a number the way the page does: a code to WhatsApp, typed back. Returns the browser's pass. */
  // The shop sends at most 3 codes to a number in 10 minutes (otp MAX_SENDS, checked in 1.): the test
  // lets that window pass between its many sign-ins rather than waiting ten real minutes.
  const windowPasses = (phone: string) => prisma.onlineShopPhoneCode.updateMany({ where: { phone: plus(phone) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const prove = async (phone: string, purpose = 'SIGNIN', slug = SLUG_A) => {
    await windowPasses(phone);
    const sent = await call(`/shop/${slug}/verify/send`, { phone, purpose });
    if (sent.status !== 200) throw new Error(`code not sent: ${JSON.stringify(sent.body)}`);
    const ok = await call(`/shop/${slug}/verify/check`, { phone, code: lastCode() });
    if (ok.status !== 200) throw new Error(`code refused: ${JSON.stringify(ok.body)}`);
    return ok.body.data.token as string;
  };
  const signIn = async (phone: string, ua?: string) => {
    const pass = await prove(phone);
    const r = await call(sa('/account/start'), { token: pass }, ua);
    if (r.status !== 200) throw new Error(`start refused: ${JSON.stringify(r.body)}`);
    return r.body.data.token as string;
  };
  const me = async (token: unknown, slug = SLUG_A) => (await call(`/shop/${slug}/account`, { token })).body?.data;

  let n = 0;
  const made: any = {};
  try {
    // ---- Two shops, each live and taking orders paid on delivery -----------------------------------
    for (const c of [A, B]) {
      await prisma.clientSettings.create({ data: { clientId: c, businessName: c === A ? 'Account Silks' : 'Other Sarees', timezone: 'Asia/Kolkata' } as any });
      const store = await prisma.stockLocation.create({ data: { clientId: c, name: 'Main Store', code: `AC${++n}${STAMP}`, type: 'STORE', active: true } as any });
      const piece = async (title: string, colour: string, price: number, qty: number) => {
        const p = await prisma.product.create({ data: { clientId: c, productCode: `AC${STAMP}-${++n}`, slug: `ac${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: price, status: 'ACTIVE' as any, publishedAt: new Date() } });
        const v = await prisma.productVariant.create({ data: { productId: p.id, clientId: c, colorName: colour, size: 'Free Size', variantCode: `ACV${STAMP}-${++n}`, sku: `ACS${STAMP}-${n}`, sellingPrice: price } });
        await prisma.productImage.create({ data: { productId: p.id, variantId: v.id, url: `https://cdn.example/${colour.toLowerCase()}-${n}.jpg`, isPrimary: true, imageType: 'GALLERY' as any } as any });
        await prisma.inventoryStock.create({ data: { clientId: c, variantId: v.id, locationId: store.id, quantity: qty, reservedQty: 0 } });
        return { p, v };
      };
      const saree = await piece('Kanchi Silk Saree', 'Green', 12000, 20);
      const kurti = await piece('Cotton Kurti', 'Blue', 1450, 0);    // sold out
      await prisma.onlineShop.create({ data: { clientId: c, slug: c === A ? SLUG_A : SLUG_B, isLive: true, acceptsOrders: true, payOnDelivery: true, locationIds: [store.id] } as any });
      made[c] = { store, saree, kurti };
    }
    const shopA = made[A];
    const order = (phone: string, extra: any = {}) => call(sa('/orders'), {
      placementKey: `acct-${STAMP}-${++n}`, lines: [{ variantCode: shopA.saree.v.variantCode, quantity: 1 }],
      name: 'Meena Iyer', phone, email: '', address: 'Flat 4, 12-3 Gandhi Road, Vijayawada', pincode: '520001', payWay: 'ON_DELIVERY', ...extra
    });
    // P1 is already the shop's customer, with points and store credit.
    const c1 = await prisma.customer.create({ data: { clientId: A, customerCode: `ACC-${STAMP}`, name: 'Meena Iyer', phone: plus(P1), loyaltyPoints: 1240, storeCreditPaise: 50000 } as any });

    console.log('\n1. SIGNING IN');
    let r = await call(sa('/account'), {});
    eq('no secret: signed out, and signing in is possible', r.body?.data, { signedIn: false, canSignIn: true });
    r = await call(sa('/verify/send'), { phone: P1, purpose: 'SIGNIN' });
    check('a sign-in code goes to their WhatsApp, saying what it is for', r.status === 200 && /is your code to sign in to Account Silks/.test(messages.at(-1)?.text ?? '') && messages.at(-1)?.to === `91${P1}`, messages.at(-1));
    r = await call(sa('/verify/check'), { phone: P1, code: lastCode() === '000000' ? '111111' : '000000' });
    eq('a wrong code: refused, tries counted', [r.status, r.body?.message], [400, 'That code is not right. 4 tries left.']);
    r = await call(sa('/verify/check'), { phone: P1, code: lastCode() });
    const pass1 = r.body?.data?.token;
    r = await call(sa('/account/start'), { token: pass1 });
    const t1 = r.body?.data?.token as string;
    check('the code typed back: signed in, with a sign-in secret of its own', r.status === 200 && typeof t1 === 'string' && t1.startsWith('ss_') && r.body?.data?.phone === plus(P1), r.body);
    let m = await me(t1);
    eq('the account: their number, their Inventory name, one phone', [m?.signedIn, m?.phone, m?.name, m?.devices], [true, plus(P1), 'Meena Iyer', 1]);
    r = await call(sa('/account/start'), { token: t1 });
    check('starting again with the sign-in itself: the same one, not another phone', r.body?.data?.token === t1 && (await prisma.onlineShopSession.count({ where: { clientId: A, phone: plus(P1) } })) === 1, r.body);
    for (const [why, token] of [['nothing', undefined], ['made up', 'not-a-real-token-at-all-123456'], ['a made-up sign-in', `ss_${'x'.repeat(43)}`]] as const) {
      r = await call(sa('/account/start'), { token });
      eq(`start refused: ${why}`, [r.status, r.body?.message], [400, 'Confirm your number with the WhatsApp code first.']);
    }
    m = await me(`ss_${'x'.repeat(43)}`);
    eq('a made-up sign-in reads nothing', m?.signedIn, false);
    m = await me(t1, SLUG_B);
    eq('this shop\'s sign-in at another shop: nobody there', m?.signedIn, false);
    const row = await prisma.onlineShopSession.findFirst({ where: { clientId: A, phone: plus(P1) } });
    check('only a hash is stored: the secret itself is nowhere in the table', !!row && row.tokenHash !== t1 && !row.tokenHash.includes(t1.slice(3, 20)) && row.tokenHash.length === 64, row?.tokenHash);
    eq('the device is a short name, not the whole user agent', row?.device, 'Chrome on Android');
    r = await call(sa('/verify/send'), { phone: P1, purpose: 'SIGNIN' });
    check('a sign-in code always goes (a number proved a minute ago is not enough on another phone)', r.status === 200 && r.body?.data?.sent === true, r.body);
    for (let i = 0; i < 2; i++) await call(sa('/verify/send'), { phone: P1, purpose: 'SIGNIN' });
    r = await call(sa('/verify/send'), { phone: P1, purpose: 'SIGNIN' });
    eq('a fourth code in 10 minutes: refused (the number is a person, not a way to ring them)', [r.status, r.body?.message], [400, 'A few codes have already gone to that number. Wait a few minutes and try again.']);
    await prisma.onlineShopPhoneCode.update({ where: { clientId_phone: { clientId: A, phone: plus(P1) } }, data: { sessionExpiresAt: new Date(Date.now() - 1000) } });
    r = await call(sa('/account/start'), { token: pass1 });
    eq('a code-check pass that has run out cannot start a sign-in', r.status, 400);

    console.log('\n2. TWO PHONES, SIGNING OUT');
    const t2 = await signIn(P1, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/604.1');
    m = await me(t1);
    eq('signed in on a second phone: the first still is, and both are counted', [m?.signedIn, m?.devices], [true, 2]);
    r = await call(sa('/account/signout'), { token: t1 });
    eq('sign out of the first phone', [r.status, (await me(t1))?.signedIn, (await me(t2))?.signedIn], [200, false, true]);
    r = await call(sa('/account/signout'), { token: t1 });
    eq('signing out twice: the same calm answer', [r.status, r.body?.data?.signedOut], [200, true]);
    const t3 = await signIn(P1);
    const legacy = await prove(P1);
    r = await call(sa('/account/signout'), { token: t3, everywhere: true });
    eq('sign out on all phones: every sign-in, and the code pass too', [r.status, (await me(t2))?.signedIn, (await me(t3))?.signedIn, (await call(sa('/addresses'), { token: legacy })).status], [200, false, false, 400]);
    const many: string[] = [];
    for (let i = 0; i < 11; i++) { many.push(await signIn(P1)); await new Promise(x => setTimeout(x, 5)); }
    m = await me(many[10]);
    eq('11 phones: the one used longest ago is signed out, 10 stay', [m?.devices, (await me(many[0]))?.signedIn, (await me(many[1]))?.signedIn], [10, false, true]);
    await prisma.onlineShopSession.updateMany({ where: { clientId: A, phone: plus(P1) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    eq('90 days on, a sign-in has run out', (await me(many[10]))?.signedIn, false);
    const tP1 = await signIn(P1);
    const s90 = await prisma.onlineShopSession.findFirst({ where: { clientId: A, phone: plus(P1), revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    const days = s90 ? Math.round((s90.expiresAt.getTime() - s90.createdAt.getTime()) / 86_400_000) : 0;
    eq('a sign-in lasts 90 days', days, 90);

    console.log('\n3. THE CHECKOUT');
    r = await order(P2);
    const guestUnproved = r.body?.data;
    check('a guest orders without proving: placed, but not proved', r.status === 200 && !!guestUnproved?.token, r.body);
    const passP2 = await prove(P2, 'ORDER');
    r = await order(P2);
    const lateUnproved = await prisma.onlineShopOrder.findUnique({ where: { token: r.body?.data?.token ?? 'x' }, select: { phoneVerified: true } });
    eq('the number proved, but the order sent without this browser\'s pass: not proved (per browser, not per number)', lateUnproved?.phoneVerified, false);
    // The checkout page sends its pass with the order, as here.
    r = await order(P2, { token: passP2 });
    const guestProved = r.body?.data;
    const g = await prisma.onlineShopOrder.findUnique({ where: { token: guestProved?.token ?? 'x' }, select: { phoneVerified: true } });
    eq('the same guest proves their number at the checkout: the order is proved', [r.status, g?.phoneVerified], [200, true]);
    r = await call(sa('/account/start'), { token: passP2 });
    const tP2 = r.body?.data?.token;
    m = await me(tP2);
    check('...and their order page signs them in: the proved order is there, the unproved one is not', r.status === 200 && m?.signedIn && m.orders.some((o: any) => o.token === guestProved.token) && !m.orders.some((o: any) => o.token === guestUnproved.token), m?.orders);
    r = await order(P1, { token: tP1 });
    const own = await prisma.onlineShopOrder.findUnique({ where: { token: r.body?.data?.token ?? 'x' }, select: { phoneVerified: true, salesOrder: { select: { customerId: true } } } });
    eq('signed in, no code: the order is proved and on their own customer record', [r.status, own?.phoneVerified, own?.salesOrder?.customerId], [200, true, c1.id]);
    r = await order(P3, { token: tP1 });
    const other = await prisma.onlineShopOrder.findUnique({ where: { token: r.body?.data?.token ?? 'x' }, select: { phoneVerified: true } });
    eq('signed in as one number, ordering for another: that number is NOT proved by it', [r.status, other?.phoneVerified], [200, false]);
    r = await order(P1);
    const stranger = r.body?.data?.token;
    m = await me(tP1);
    check('an order somebody placed on this number without proving it is not in this account', !m.orders.some((o: any) => o.token === stranger) && m.orders.length === 1, m.orders.map((o: any) => o.token));
    eq('the account\'s order: number, state, total, pieces, picture', [m.orders[0]?.state, m.orders[0]?.total, m.orders[0]?.pieces, !!m.orders[0]?.firstImage], ['PLACED', 12000, 1, true]);
    r = await order(P1, { token: tP1, placementKey: `acct-${STAMP}-later` });
    m = await me(tP1);
    check('newest first', m.orders[0]?.token === r.body?.data?.token && m.orders.length === 2, m.orders.map((o: any) => o.orderNumber));

    console.log('\n4. POINTS AND STORE CREDIT');
    m = await me(tP1);
    eq('loyalty off in Inventory: no points shown; store credit held: shown', [m.points, m.storeCredit], [null, 500]);
    await prisma.loyaltySettings.upsert({ where: { clientId: A }, create: { clientId: A, enabled: true } as any, update: { enabled: true } });
    m = await me(tP1);
    eq('loyalty on: their points', m.points, 1240);
    await prisma.customer.update({ where: { id: c1.id }, data: { storeCreditPaise: 0 } });
    m = await me(tP1);
    eq('no credit held: none shown', m.storeCredit, null);
    m = await me(tP2);
    check('a new customer from a proved order: 0 points, no credit', m.points === 0 && m.storeCredit === null, [m.points, m.storeCredit]);

    console.log('\n5. THE WISHLIST');
    const like = (token: unknown, code: string, liked = true, variantCode?: string) => call(sa(`/products/${encodeURIComponent(code)}/like`), { token, liked, variantCode });
    r = await like(undefined, shopA.saree.p.productCode);
    eq('signed out: a heart is refused and nothing is kept', [r.status, r.body?.message, await prisma.shopProductView.count({ where: { clientId: A, likedAt: { not: null } } })], [400, 'Sign in to save pieces you like.', 0]);
    r = await like(tP1, shopA.saree.p.productCode, true, shopA.saree.v.variantCode);
    await like(tP1, shopA.kurti.p.productCode, true, shopA.kurti.v.variantCode);
    m = await me(tP1);
    const green = m.hearts.find((h: any) => h.productCode === shopA.saree.p.productCode);
    const blue = m.hearts.find((h: any) => h.productCode === shopA.kurti.p.productCode);
    eq('hearted: the saree in its colour, price and picture; the kurti sold out', [r.status, green?.colour, green?.price, green?.available, /green/.test(green?.imageUrl ?? ''), blue?.available], [200, 'Green', 12000, true, true, false]);
    r = await like(tP1, made[B].saree.p.productCode);
    eq('another shop\'s piece cannot be hearted here', r.status, 400);
    await prisma.product.update({ where: { id: shopA.kurti.p.id }, data: { status: 'ARCHIVED' as any } });
    m = await me(tP1);
    check('a piece taken off sale leaves the list (the heart is kept)', !m.hearts.some((h: any) => h.productCode === shopA.kurti.p.productCode) && (await prisma.shopProductView.count({ where: { clientId: A, productId: shopA.kurti.p.id, likedAt: { not: null } } })) === 1, m.hearts.map((h: any) => h.productCode));
    await prisma.product.update({ where: { id: shopA.kurti.p.id }, data: { status: 'ACTIVE' as any } });
    m = await me(tP1);
    check('...and comes back when it is on sale again', m.hearts.some((h: any) => h.productCode === shopA.kurti.p.productCode));
    await like(tP1, shopA.kurti.p.productCode, false);
    m = await me(tP1);
    eq('heart taken off: gone from the list', m.hearts.map((h: any) => h.productCode), [shopA.saree.p.productCode]);
    const old = new Date(Date.now() - 40 * 86_400_000);
    await prisma.shopProductView.updateMany({ where: { clientId: A, phone: plus(P1) }, data: { lastAt: old } });
    await forgetOldViews();
    m = await me(tP1);
    eq('40 days on, housekeeping: the hearted saree stays, the un-hearted kurti look goes', [m.hearts.map((h: any) => h.productCode), await prisma.shopProductView.count({ where: { clientId: A, phone: plus(P1) } })], [[shopA.saree.p.productCode], 1]);

    console.log('\n6. SAVED ADDRESSES');
    m = await me(tP1);
    check('the proved order\'s address is saved on their account', m.addresses.length >= 1 && /Gandhi Road/.test(m.addresses[0]?.line ?? ''), m.addresses);
    r = await call(sa('/addresses/remove'), { token: tP1, id: m.addresses[0]?.id });
    m = await me(tP1);
    eq('removed from the account page', [r.status, m.addresses.length], [200, 0]);

    console.log('\n7. A CLOSED SHOP, A DELETED CUSTOMER');
    await prisma.onlineShop.update({ where: { clientId: A }, data: { isLive: false } });
    r = await call(sa('/account'), { token: tP1 });
    eq('the shop closed: the account is not served', [r.status, r.body?.message], [400, 'This shop is not open just now.']);
    await prisma.onlineShop.update({ where: { clientId: A }, data: { isLive: true } });
    const c2 = await prisma.customer.findFirstOrThrow({ where: { clientId: A, phone: plus(P2), deletedAt: null } });
    await prisma.salesOrder.updateMany({ where: { clientId: A, customerId: c2.id }, data: { status: 'DISPATCHED' as any } });
    await customerDelete.deleteCustomer(A, c2.id, P2.slice(-4));
    eq('the customer deleted in Inventory: signed out of the shop, their sign-ins gone', [(await me(tP2))?.signedIn, await prisma.onlineShopSession.count({ where: { clientId: A, phone: plus(P2) } })], [false, 0]);
  } catch (e: any) {
    console.error(e);
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).split('\n')[0]})`, false);
  } finally {
    for (const c of [A, B]) await platformAdminService.deleteClientCompletely(c, c).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', c, e?.message); });
    const left = await prisma.onlineShopSession.count({ where: { clientId: { in: [A, B] } } });
    check('cleanup: no sign-ins left behind', left === 0, left);
    server.close(); await wa.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
