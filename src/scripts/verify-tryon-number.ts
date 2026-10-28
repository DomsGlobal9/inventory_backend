/**
 * The shopper's WhatsApp number before a try-on (owner, 28 Oct): proved with a code, required when
 * the shop's WhatsApp is linked, and the old anonymous try-on when it is not (the owner's fallback).
 *
 * Over HTTP through the REAL routes -- the tag's QR page (/public/tryon) and the online shop
 * (/shop/:slug) -- with stand-ins only for what would reach the outside world: the WhatsApp service
 * (answers "connected" or not, and captures the code instead of messaging anybody), the paid try-on
 * gateway and the photo storage.
 *
 * LOCAL DATABASE ONLY.
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory DIRECT_URL=<same> npx tsx src/scripts/verify-tryon-number.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import http from 'http';
import { AddressInfo } from 'net';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const STAMP = Date.now();
const A = `tryon-number-a-${STAMP}`;   // WhatsApp linked: asks for the number
const B = `tryon-number-b-${STAMP}`;   // WhatsApp not linked: anonymous, as before
const PHONE = '9000012345';            // a made-up number; the stand-in never sends anything

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
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise(r => server.close(() => r()))
    }));
  });

(async () => {
  // The WhatsApp service: shop A connected, B not. Messages are captured, never sent.
  const messages: { clientId: string; to: string; text: string }[] = [];
  const wa = await serve((req, body) => {
    const m = /^\/v1\/accounts\/client\/([^/]+)$/.exec(req.url || '');
    if (req.method === 'GET' && m) return [200, { status: decodeURIComponent(m[1]) === A ? 'CONNECTED' : 'DISCONNECTED' }];
    if (req.method === 'POST' && req.url === '/v1/messages') {
      messages.push({ clientId: body?.from?.clientId, to: body?.to, text: body?.text });
      return [200, { id: `msg-${messages.length}-${STAMP}`, status: 'SENT' }];
    }
    return [404, { message: 'not in the stand-in' }];
  });
  let gatewayCalls = 0;
  const gw = await serve(() => { gatewayCalls++; return [200, { success: true, resultImageUrl: 'https://cdn.example/result.jpg' }]; });
  process.env.WHATSAPP_SERVICE_URL = wa.url;
  process.env.WHATSAPP_SERVICE_KEY = 'local-stand-in-key';
  process.env.SHOPPER_TRYON_GATEWAY_URL = gw.url;
  process.env.SHOPPER_TRYON_API_KEY = 'sk_shared_shopper_key_for_local_test';

  const express = (await import('express')).default;
  const sharp = (await import('sharp')).default;
  const { prisma } = await import('../lib/prisma');
  const { supabase } = await import('../lib/supabase');
  const publicRoutes = (await import('../routes/shopper-tryon-public.routes')).default;
  const shopRoutes = (await import('../routes/shop-public.routes')).default;
  const otp = await import('../services/online-shop/otp');
  (supabase as any).storage.from = () => ({
    upload: async () => ({ error: null }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.example/${path}` } }),
    remove: async () => ({ error: null })
  });

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/t', publicRoutes);
  app.use('/shop', shopRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown) => fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const lastCode = () => /(\d{6}) is your code/.exec(messages[messages.length - 1]?.text ?? '')?.[1] ?? '';
  const photo = (await sharp({ create: { width: 320, height: 480, channels: 3, background: '#a0522d' } }).jpeg().toBuffer()).toString('base64');

  let n = 0;
  const made: Record<string, any> = {};
  const product = (clientId: string) => prisma.product.create({ data: { clientId, productCode: `N${STAMP}-${++n}`, slug: `n${STAMP}-${n}`, title: 'Kanchi Saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any } });
  const views = (clientId: string) => prisma.shopProductView.findMany({ where: { clientId }, select: { phone: true, productId: true, tryOns: true } });
  const counted = (clientId: string) => prisma.garmentTryOnDay.aggregate({ where: { clientId }, _sum: { completed: true } }).then(a => a._sum.completed ?? 0);

  try {
    for (const c of [A, B]) {
      const p = await product(c);
      const v = await prisma.productVariant.create({ data: { productId: p.id, clientId: c, colorName: 'Green', size: 'Free', variantCode: `NV${STAMP}-${++n}`, sku: `NS${STAMP}-${n}`, sellingPrice: 1000 } });
      await prisma.productImage.create({ data: { productId: p.id, variantId: v.id, url: 'https://cdn.example/green.jpg', isPrimary: true, imageType: 'GALLERY' as any } as any });
      const store = await prisma.stockLocation.create({ data: { clientId: c, name: `Store ${c}`, code: `N${++n}${STAMP}`, type: 'STORE', active: true } as any });
      await prisma.onlineShop.create({ data: { clientId: c, slug: `tn-${c === A ? 'a' : 'b'}-${STAMP}`, isLive: true, tryOn: true, locationIds: [store.id] } as any });
      made[c] = { p, v, slug: `tn-${c === A ? 'a' : 'b'}-${STAMP}` };
    }
    const a = made[A], b = made[B];
    const tagGen = (clientId: string, code: string, extra: any = {}) => call('POST', `/t/${clientId}/${code}/generate`, { humanImageUrl: 'https://cdn.example/me.jpg', variant: made[clientId].v.variantCode, ...extra });

    console.log('\n1. THE TAG, SHOP WITH WHATSAPP LINKED');
    let r = await call('GET', `/t/${A}/${a.p.productCode}`);
    eq('look-up says a number is needed', [r.status, r.body?.data?.needsNumber], [200, true]);
    r = await tagGen(A, a.p.productCode);
    eq('try-on without a number: 400 with needsNumber, a sentence', [r.status, r.body?.needsNumber, r.body?.message], [400, true, 'Confirm your WhatsApp number to try this on.']);
    r = await tagGen(A, a.p.productCode, { token: 'x'.repeat(32) });
    eq('a made-up pass: the same refusal', [r.status, r.body?.needsNumber], [400, true]);
    eq('nothing reached the gateway, nothing counted', [gatewayCalls, await counted(A)], [0, 0]);

    r = await call('POST', `/t/${A}/verify/send`, { phone: '12' });
    eq('a number that is not a number: a sentence', [r.status, r.body?.message], [400, 'That phone number does not look right. Check it and try again.']);
    r = await call('POST', `/t/${A}/verify/send`, { phone: PHONE });
    eq('code sent: 200', [r.status, r.body?.data?.sent], [200, true]);
    const msg = messages[messages.length - 1];
    check('the WhatsApp message is the try-on one, from shop A, to that number', msg?.clientId === A && msg?.to?.endsWith(PHONE) && /^\d{6} is your code to try on clothes at /.test(msg?.text ?? ''), msg);
    r = await call('POST', `/t/${A}/verify/check`, { phone: PHONE, code: lastCode() === '000000' ? '111111' : '000000' });
    eq('a wrong code: how many tries are left', [r.status, r.body?.message], [400, 'That code is not right. 4 tries left.']);
    r = await call('POST', `/t/${A}/verify/check`, { phone: PHONE, code: lastCode() });
    const token = r.body?.data?.token;
    check('the right code: a pass back', r.status === 200 && typeof token === 'string' && token.length >= 20, r);

    r = await tagGen(A, a.p.productCode, { token });
    eq('try-on with the pass: 200, the picture', [r.status, r.body?.data?.resultImageUrl], [200, 'https://cdn.example/result.jpg']);
    await new Promise(x => setTimeout(x, 400));
    eq('kept against their number (Customer card, CRM): one try-on of this saree', (await views(A)).map(v => [v.phone.endsWith(PHONE), v.productId === a.p.id, v.tryOns]), [[true, true, 1]]);
    eq('and in the garment totals', await counted(A), 1);
    check('the pass never travels back to the shopper as their number', !JSON.stringify(r.body).includes(PHONE));

    r = await tagGen(B, b.p.productCode, { token });
    check('shop A\'s pass at shop B is just ignored there (B asks nobody)', r.status === 200, r);
    eq('...and nothing is kept against the number at B', (await views(B)).length, 0);

    console.log('\n2. THE TAG, SHOP WITHOUT WHATSAPP (the fallback)');
    r = await call('GET', `/t/${B}/${b.p.productCode}`);
    eq('look-up: no number needed', r.body?.data?.needsNumber, false);
    r = await tagGen(B, b.p.productCode);
    eq('try-on with no number: 200, as before', r.status, 200);
    r = await call('POST', `/t/${B}/verify/send`, { phone: PHONE });
    eq('asking B for a code: a plain sentence, nothing sent', [r.status, r.body?.message], [400, 'This shop cannot send a code just now. Try again in a little while.']);
    await new Promise(x => setTimeout(x, 300));
    eq('B: counted in the totals only (2 try-ons), no person', [await counted(B), (await views(B)).length], [2, 0]);

    console.log('\n3. PASSES THAT RUN OUT, AND RE-SENDS');
    await prisma.onlineShopPhoneCode.updateMany({ where: { clientId: A, sessionToken: token }, data: { sessionExpiresAt: new Date(Date.now() - 1000) } });
    r = await tagGen(A, a.p.productCode, { token });
    eq('a pass that ran out: back to the number step', [r.status, r.body?.needsNumber], [400, true]);
    const before = messages.length;
    r = await call('POST', `/t/${A}/verify/send`, { phone: PHONE });
    check('a number proved minutes ago still gets a fresh code for a try-on (a pass is per phone)', r.status === 200 && r.body?.data?.sent === true && messages.length === before + 1, r.body);
    r = await call('POST', `/t/${A}/verify/send`, { phone: PHONE });
    eq('a third code in ten minutes: still allowed', r.status, 200);
    r = await call('POST', `/t/${A}/verify/send`, { phone: PHONE });
    eq('a fourth: refused, in try-on words', [r.status, r.body?.message], [400, 'A few codes have already gone to that number. Wait a few minutes and try again.']);
    r = await call('POST', `/t/${A}/verify/check`, { phone: PHONE, code: lastCode() });
    eq('a 9th code request from one address in 10 minutes: slowed down with a sentence', [r.status, r.body?.message], [429, 'Too many attempts just now. Wait a few minutes and try again.']);
    // (the same check the route runs, without the per-address limit)
    const t2 = (await otp.checkCode(A, PHONE, lastCode())).token;

    console.log('\n4. THE ONLINE SHOP');
    r = await call('GET', `/shop/${a.slug}`);
    eq('shop A tells its page it can prove numbers', r.body?.data?.canVerifyPhone, true);
    r = await call('POST', `/shop/${a.slug}/products/${a.p.productCode}/tryon`, { photo, variantCode: a.v.variantCode });
    eq('try-on without a number: 400 with needsNumber', [r.status, r.body?.needsNumber, r.body?.message], [400, true, 'Confirm your WhatsApp number to try this on.']);
    r = await call('POST', `/shop/${a.slug}/products/${a.p.productCode}/tryon`, { photo, variantCode: a.v.variantCode, token: t2 });
    eq('with the pass: 200', [r.status, r.body?.message, typeof t2], [200, undefined, 'string']);
    await new Promise(x => setTimeout(x, 400));
    eq('their row now has two try-ons of this saree', (await views(A)).map(v => v.tryOns), [2]);
    r = await call('POST', `/shop/${b.slug}/products/${b.p.productCode}/tryon`, { photo, variantCode: b.v.variantCode });
    eq('shop B online, no number: 200, as before', r.status, 200);
    r = await call('POST', `/shop/${a.slug}/verify/send`, { phone: '9000054321', purpose: 'TRYON' });
    check('online, purpose TRYON: the try-on wording', r.status === 200 && /to try on clothes at/.test(messages[messages.length - 1]?.text ?? ''), r.body);
    r = await call('POST', `/shop/${a.slug}/verify/send`, { phone: '9000067890' });
    check('the checkout\'s code is unchanged: "confirm your order"', r.status === 200 && /to confirm your order with/.test(messages[messages.length - 1]?.text ?? ''), messages[messages.length - 1]);
    // A checkout number proved minutes ago still skips the code at the checkout (unchanged).
    await otp.checkCode(A, '9000067890', lastCode());
    r = await call('POST', `/shop/${a.slug}/verify/send`, { phone: '9000067890' });
    eq('checkout: a number proved minutes ago is not sent another code (unchanged)', r.body?.data?.alreadyVerified, true);

    eq('the gateway was reached only by try-ons that were allowed', gatewayCalls, 5);
  } catch (e: any) {
    console.error(e);
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).trim().split('\n')[0]})`, false);
  } finally {
    for (const clientId of [A, B]) {
      const w = { clientId };
      for (const [what, run] of [
        ['views', () => prisma.shopProductView.deleteMany({ where: w })],
        ['codes', () => prisma.onlineShopPhoneCode.deleteMany({ where: w })],
        ['counts', () => prisma.garmentTryOnDay.deleteMany({ where: w })],
        ['usage', () => prisma.tryOnUsage.deleteMany({ where: w })],
        ['messages', () => prisma.whatsAppMessage.deleteMany({ where: w })],
        ['shop', () => prisma.onlineShop.deleteMany({ where: w })],
        ['images', () => prisma.productImage.deleteMany({ where: { product: w } })],
        ['variants', () => prisma.productVariant.deleteMany({ where: w })],
        ['products', () => prisma.product.deleteMany({ where: w })],
        ['stores', () => prisma.stockLocation.deleteMany({ where: w })]
      ] as [string, () => Promise<unknown>][]) await run().catch(e => console.log(`left ${what}`, e.message));
    }
    server.close(); await wa.close(); await gw.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
