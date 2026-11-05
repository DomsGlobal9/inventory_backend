/**
 * The worst cases for reviews, sign-in and the shop's product list (5 Nov, owner: "all edge case worst case
 * scenarios"). Everything here is what someone careless or hostile would send, or what goes wrong at a bad moment.
 *   A. what is typed: stars that are not stars, oversized, hostile, or binary text;
 *   B. what is uploaded: bombs, fakes, other people's photos, other shops', addresses that lead nowhere;
 *   C. who it comes from: odd tokens, cancelled, partly delivered, archived, a number typed differently;
 *   D. many at once: racing saves, paging through identical timestamps;
 *   E. CRM's routes over HTTP with real signed tokens: no token, wrong scope, wrong shop, wrong person, bad reason;
 *   F. erasing: a customer, and a whole shop;
 *   G. signing in: capitals, spaces, objects for emails, a real trailing space, suspended, throttled;
 *   H. the product list: nonsense prices, odd search text.
 *
 * LOCAL DATABASE AND STORAGE STAND-IN ONLY. Needs reviews-backend-4026.mjs (it trusts CRM_KEY's public half).
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) { console.error('Refusing: local database only.'); process.exit(2); }
if (!String(process.env.SUPABASE_URL || '').includes('127.0.0.1:18200')) { console.error('Refusing: the storage stand-in only.'); process.exit(2); }
import fs from 'node:fs';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import zlib from 'node:zlib';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { supabase } from '../lib/supabase';
import { dispatchService } from '../services/dispatch.service';
import { deleteCustomer } from '../services/customer-delete';
import { platformAdminService } from '../services/platform-admin.service';
import { readablePassword } from '../lib/readablePassword';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 320)}` : ''}`); }
};
const C = 'verify-suites-tenant', SLUG = 'localshop', LOCATION = '0e3adb72-1143-4b80-b92b-bbbb2612fe19';
const STAMP = String(Date.now()).slice(-6);
const CODES = 'C:/Users/HP/AppData/Local/Temp/claude/D--villy-inventory/9bd5afd2-c77c-4f44-bec2-3d5913e47e09/scratchpad/codes.jsonl';
const num = (k: number) => `90${k}${STAMP}${k}`.slice(0, 10);
const P1 = num(1), P2 = num(2), P3 = num(3), P4 = num(4);
const privateKey = fs.readFileSync(process.env.CRM_KEY as string, 'utf8');

const raw = (path: string, method: string, body: string | undefined, headers: Record<string, string>) => new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: 4026, path, method, headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) } }, (res) => {
    let t = ''; res.on('data', c => { t += c; });
    res.on('end', () => { let b = null; try { b = JSON.parse(t); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, body: b, text: t }); });
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});
const call = (path: string, body?: unknown) => raw(`/_api/shop/${SLUG}${path}`, body === undefined ? 'GET' : 'POST', body === undefined ? undefined : JSON.stringify(body), { host: 'shop.localhost:4006' });
const api = (path: string, method = 'POST', body?: unknown) => raw(`/api/v1${path}`, method, body === undefined ? undefined : JSON.stringify(body), { host: '127.0.0.1:4026' });
const sent = (phone: string) => fs.readFileSync(CODES, 'utf8').trim().split('\n').filter(Boolean).filter(l => String(JSON.parse(l).to).endsWith(phone)).length;
const codeFor = async (phone: string, after: number) => {
  for (let i = 0; i < 80; i++) {
    const rows = fs.readFileSync(CODES, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => String(l.to).endsWith(phone)).slice(after);
    const m = /(\d{6}) is your code/.exec(rows.at(-1)?.text ?? ''); if (m) return m[1];
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`no code for ${phone}`);
};
const prove = async (phone: string) => {
  const before = sent(phone);
  const s = await call('/verify/send', { phone, purpose: 'SIGNIN' });
  if (s.status !== 200) throw new Error(`code not sent: ${s.text.slice(0, 200)}`);
  const ok = await call('/verify/check', { phone, code: await codeFor(phone, before) });
  if (ok.status !== 200) throw new Error(`code refused: ${ok.text.slice(0, 200)}`);
  return ok.body.data.token as string;
};
/** Not a crash, and something a person can read: a 4xx with a sentence, never a 500 or a raw error. */
const calm = (r: { status: number; body: any }) => r.status >= 400 && r.status < 500 && typeof r.body?.message === 'string' && !/prisma|invalid .* invocation|sql|stack|undefined/i.test(r.body.message);

async function main() {
  const was = await prisma.onlineShop.findFirstOrThrow({ where: { clientId: C }, select: { id: true, acceptsOrders: true, payOnDelivery: true, reviews: true, accounts: true } });
  await prisma.onlineShop.update({ where: { id: was.id }, data: { acceptsOrders: true, payOnDelivery: true, reviews: true, accounts: true } });
  const madeProducts: string[] = [], madeUsers: string[] = [];
  const other = `rvworst-${STAMP}`;
  let n = 0;
  const product = async (tag: string, extra: any = {}) => {
    const p = await prisma.product.create({ data: { clientId: C, productCode: `RW${STAMP}-${tag}`, slug: `rw${STAMP}-${tag}`.toLowerCase(), title: `Worst ${tag}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date(), ...extra } as any });
    madeProducts.push(p.id);
    const v = await prisma.productVariant.create({ data: { productId: p.id, clientId: C, colorName: 'Red', size: 'M', variantCode: `RWV${STAMP}-${tag}`, sku: `RWS${STAMP}-${tag}`, sellingPrice: 1000, costPrice: 1, reorderLevel: 0 } as any });
    await prisma.inventoryStock.create({ data: { clientId: C, variantId: v.id, locationId: LOCATION, quantity: 40, reservedQty: 0 } });
    return { code: p.productCode, id: p.id, v };
  };
  const order = async (phone: string, item: any, name = 'Kavya Reddy') => {
    const r = await call('/orders', { placementKey: `worst-suite-${STAMP}-${++n}`, lines: [{ variantCode: item.v.variantCode, quantity: 1 }], name, phone, email: '', address: 'Flat 4, 12-3 Gandhi Road, Vijayawada', pincode: '520001', payWay: 'ON_DELIVERY' });
    if (r.status !== 200) throw new Error(`order refused: ${r.text.slice(0, 200)}`);
    return r.body.data.token as string;
  };
  const dispatched = async (token: string) => {
    const row = await prisma.onlineShopOrder.findUniqueOrThrow({ where: { token }, select: { salesOrderId: true, salesOrder: { select: { items: { select: { id: true, quantity: true } } } } } });
    const sentRow: any = await prisma.$transaction(tx => dispatchService.dispatchInTransaction(tx, C, row.salesOrderId, row.salesOrder.items.map(i => ({ salesOrderItemId: i.id, quantity: i.quantity })), {}), { timeout: 30000, maxWait: 15000 });
    return { dispatchId: sentRow.id as string, salesOrderId: row.salesOrderId };
  };
  const deliver = async (token: string) => { const d = await dispatched(token); await prisma.dispatch.update({ where: { id: d.dispatchId }, data: { status: 'DELIVERED', deliveredAt: new Date() } }); return d; };
  const review = (code: string, token: string, body: any) => call(`/products/${code}/reviews`, { token, ...body });

  try {
    const A = await product('A'); const t1 = await prove(P1); const oA = await order(P1, A); await deliver(oA);

    console.log('\nA. WHAT IS TYPED');
    for (const bad of [true, false, [5], {}, '', ' ', 'five', '5.5', -1, 99, NaN, null]) {
      const r = await review(A.code, t1, { rating: bad });
      check(`rating ${JSON.stringify(bad)}: refused in a sentence`, r.status === 400 && /1 to 5/.test(r.body?.message), r.body ?? r.text.slice(0, 100));
    }
    let r = await review(A.code, t1, { rating: '5' });
    check('rating "5" from a form: taken as 5', r.status === 200 && r.body?.data?.rating === 5, r.body);
    r = await review(A.code, t1, { rating: 4, body: 'x'.repeat(5000) });
    let row = await prisma.shopReview.findFirstOrThrow({ where: { productId: A.id } });
    check('5,000 characters: kept to 1,000, not refused', r.status === 200 && row.body?.length === 1000, row.body?.length);
    for (const [label, body] of [['an object', { a: 1 }], ['an array', ['x']], ['a number', 12345], ['only spaces', '   \n\n  ']] as const) {
      r = await review(A.code, t1, { rating: 4, body });
      row = await prisma.shopReview.findFirstOrThrow({ where: { productId: A.id } });
      check(`words that are ${label}: saved with no words`, r.status === 200 && row.body === null, row.body);
    }
    const telugu = '🙂 తెలుగు చాలా బాగుంది! अच्छा है 😍';
    await review(A.code, t1, { rating: 5, body: telugu });
    r = await call(`/products/${A.code}/reviews`);
    check('Telugu, Hindi and emoji come back exactly', r.body?.data?.reviews?.[0]?.body === telugu, r.body?.data?.reviews?.[0]?.body);
    const hostile = `<img src=x onerror=alert(1)> <script>alert(2)</script> '; DROP TABLE shop_reviews; -- \u0000\u0007 end`;
    r = await review(A.code, t1, { rating: 5, body: hostile });
    check('hostile text with a NUL byte: saved, not a crash', r.status === 200, r.text.slice(0, 200));
    r = await call(`/products/${A.code}/reviews`);
    check('...kept as plain words, control characters gone; the table is still there', r.body?.data?.reviews?.[0]?.body?.includes('DROP TABLE') && !/[\u0000\u0007]/.test(r.body?.data?.reviews?.[0]?.body), r.body?.data?.reviews?.[0]?.body);
    r = await review(A.code, t1, { rating: 5, body: `${'a'.repeat(999)}😍` });
    check('an emoji cut in half at the limit: no crash', r.status === 200, r.text.slice(0, 200));
    for (const tags of ['Good quality', { 0: 'x' }, 12, Array(800).fill('Good quality'), ['\u0000', null, 3, {}]]) {
      r = await review(A.code, t1, { rating: 5, tags });
      row = await prisma.shopReview.findFirstOrThrow({ where: { productId: A.id } });
      check(`tags ${JSON.stringify(tags).slice(0, 24)}: only real tags, once each`, r.status === 200 && row.tags.every(t => t === 'Good quality') && row.tags.length <= 1, row.tags);
    }
    r = await raw(`/_api/shop/${SLUG}/products/${A.code}/reviews`, 'POST', JSON.stringify({ token: t1, rating: 5, body: 'y'.repeat(40_000) }), { host: 'shop.localhost:4006' });
    check('a 40KB request: refused, no crash', r.status === 413 || r.status === 400, r.status);

    console.log('\nB. WHAT IS UPLOADED');
    const jpeg = await sharp({ create: { width: 500, height: 600, channels: 3, background: '#7a1f3d' } }).jpeg().toBuffer();
    const dataUrl = (b: Buffer, t = 'image/jpeg') => `data:${t};base64,${b.toString('base64')}`;
    const up = (code: string, token: string, photo: unknown) => call(`/products/${code}/reviews/photo`, { token, photo });
    for (const [label, photo] of [['nothing', undefined], ['empty', ''], ['a number', 5], ['an object', { a: 1 }], ['text pretending', 'data:image/png;base64,aGVsbG8='], ['not base64', 'data:image/png;base64,@@@@@'], ['an HTML page', dataUrl(Buffer.from('<html><script>alert(1)</script></html>'), 'text/html')]] as const) {
      r = await up(A.code, t1, photo);
      check(`a "photo" that is ${label}: refused in a sentence`, r.status === 400 && calm(r), r.body ?? r.text.slice(0, 80));
    }
    // A picture bomb: a tiny file that claims to be 20,000 x 20,000 (400 megapixels), built by hand.
    const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(20000, 0); ihdr.writeUInt32BE(20000, 4); ihdr[8] = 8; ihdr[9] = 2;
    const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(1000))), chunk('IEND', Buffer.alloc(0))]);
    r = await up(A.code, t1, dataUrl(bomb, 'image/png'));
    check(`a picture bomb (400 megapixels in ${bomb.length} bytes): refused, the server stays up`, r.status === 400 && calm(r), r.body ?? r.status);
    r = await raw(`/_api/shop/${SLUG}/products/${A.code}/reviews/photo`, 'POST', JSON.stringify({ token: t1, photo: `data:image/jpeg;base64,${'A'.repeat(13 * 1024 * 1024)}` }), { host: 'shop.localhost:4006' });
    check('13MB: refused with a sentence about the size', r.status === 413 && /too large/.test(r.body?.message), r.body ?? r.status);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script><rect width="100" height="100" fill="red"/></svg>');
    r = await up(A.code, t1, dataUrl(svg, 'image/svg+xml'));
    if (r.status === 200) {
      const stored = Buffer.from(await (await fetch(r.body.data.url)).arrayBuffer());
      check('an SVG with a script: if taken, it is re-drawn as a plain JPEG', !stored.includes('script') && (await sharp(stored).metadata()).format === 'jpeg');
    } else check('an SVG with a script: refused', calm(r), r.body);
    r = await up(A.code, t1, dataUrl(jpeg));
    const myUrl: string = r.body?.data?.url;
    check('a real photo uploads', r.status === 200 && !!myUrl, r.body);

    const B = await product('B'); const t2 = await prove(P2); await deliver(await order(P2, B)); await deliver(await order(P2, A));
    r = await review(B.code, t2, { rating: 5, photos: [myUrl] });
    check('someone else\'s uploaded photo: cannot be put on my review', r.status === 400, r.body);
    const base = myUrl.slice(0, myUrl.indexOf('reviews/'));
    for (const [label, url] of [
      ['in another shop', `${base}reviews/some-other-shop/11111111-1111-1111-1111-111111111111.jpg`],
      ['climbing out of the folder', `${base}reviews/${C}/../../secret.jpg`],
      ['a product picture of this shop', `${base}products/${C}/x.jpg`],
      ['on another website', 'https://evil.example/reviews/x.jpg'],
      ['that was never uploaded', myUrl.replace(/[0-9a-f]{8}-[0-9a-f]{4}/, '00000000-0000')],
      ['not text', { url: myUrl }],
    ] as const) {
      r = await review(A.code, t1, { rating: 5, photos: [url] });
      check(`a photo address ${label}: refused`, r.status === 400 && calm(r), r.body);
    }
    r = await review(A.code, t1, { rating: 5, photos: 'not a list' });
    check('photos that are not a list: no photos, no crash', r.status === 200, r.text.slice(0, 120));
    r = await review(A.code, t1, { rating: 5, photos: [myUrl] });
    check('my own photo on my own review: fine', r.status === 200, r.body);
    r = await review(A.code, t1, { rating: 5, photos: [myUrl, myUrl, myUrl] });
    row = await prisma.shopReview.findFirstOrThrow({ where: { productId: A.id } });
    check('the same photo three times: kept once', r.status === 200 && (row.photos as any[]).length === 1, row.photos);

    console.log('\nC. WHO IT COMES FROM');
    for (const token of [undefined, null, '', 123, ['x'], { a: 1 }, 'x'.repeat(5000), 'ss_notarealsession0000000000000000']) {
      r = await review(A.code, token as any, { rating: 5 });
      check(`token ${JSON.stringify(token)?.slice(0, 22)}: refused in a sentence`, r.status === 400 && /Sign in/.test(r.body?.message), r.body ?? r.status);
    }
    for (const code of ['NOPE', '%27%20OR%201%3D1', '..%2F..%2Fetc', 'x'.repeat(400), '%F0%9F%98%8D']) {
      r = await call(`/products/${code}/reviews`);
      check(`item code ${code.slice(0, 18)}: not found, in a sentence`, r.status === 400 && /could not be found/.test(r.body?.message) || r.status === 404, r.body ?? r.status);
    }
    const Cancelled = await product('C'); const t3 = await prove(P3); const oC = await order(P3, Cancelled);
    const dC = await deliver(oC);
    await prisma.salesOrder.update({ where: { id: dC.salesOrderId }, data: { status: 'CANCELLED' as any } });
    r = await review(Cancelled.code, t3, { rating: 1 });
    check('a cancelled order: cannot be reviewed', r.status === 400, r.body);
    r = await call('/reviews/feedback', { orderToken: oC, body: 'Late' });
    check('...nor sent feedback', r.status === 400, r.body);
    const Part = await product('P'); const oP = await order(P3, Part); const dP = await deliver(oP);
    await prisma.salesOrder.update({ where: { id: dP.salesOrderId }, data: { status: 'PARTIALLY_DISPATCHED' as any } });
    r = await review(Part.code, t3, { rating: 3 });
    check('only part of an order delivered: not yet', r.status === 400, r.body);
    const Old = await product('O'); const oO = await order(P3, Old, 'Anita'); const dO = await deliver(oO);
    r = await review(Old.code, t3, { rating: 5, body: 'Before it was cancelled' });
    check('delivered, reviewed...', r.status === 200, r.body);
    await prisma.salesOrder.update({ where: { id: dO.salesOrderId }, data: { status: 'CANCELLED' as any } });
    r = await review(Old.code, t3, { rating: 4, body: 'Still mine to change' });
    check('...then the order is cancelled: they can still change or remove their review', r.status === 200, r.body);
    r = await call('/reviews/feedback', { orderToken: 'x'.repeat(3000), body: 'Hello' });
    check('a 3,000-character order link: refused', r.status === 400, r.status);
    r = await call('/reviews/order', { orderToken: { a: 1 } });
    check('an object for an order link: refused', r.status === 400, r.status);
    const Zero = await product('Z'); const t4 = await prove(P4); await deliver(await order(`0${P4}`, Zero));
    r = await review(Zero.code, t4, { rating: 5 });
    check('ordered with the number as 0xxxxxxxxxx, signed in as +91: recognised', r.status === 200, r.body);
    await prisma.product.update({ where: { id: Zero.id }, data: { status: 'ARCHIVED' as any } });
    r = await call(`/products/${Zero.code}/reviews`);
    check('an archived item: its reviews are not served, in a sentence', r.status === 400, r.status);
    r = await review(Zero.code, t4, { rating: 1 });
    check('...and cannot be changed', r.status === 400, r.status);
    await prisma.product.update({ where: { id: Zero.id }, data: { status: 'ACTIVE' as any } });
    await prisma.onlineShop.update({ where: { id: was.id }, data: { accounts: false } });
    await new Promise(x => setTimeout(x, 1200));
    r = await call('');
    check('accounts off: the shop says reviews are off too', r.body?.data?.reviews === false, r.body?.data?.reviews);
    await prisma.onlineShop.update({ where: { id: was.id }, data: { accounts: true } });
    await new Promise(x => setTimeout(x, 1200));

    console.log('\nD. MANY AT ONCE');
    const Page = await product('G');
    const when = new Date('2026-10-01T10:00:00Z');
    await prisma.shopReview.createMany({ data: Array.from({ length: 27 }, (_, i) => ({ clientId: C, productId: Page.id, phone: `+9190${String(1000000 + i).slice(-8)}`, rating: (i % 5) + 1, body: `Same moment ${i}`, createdAt: when })) });
    for (const sort of ['NEW', 'HIGH', 'LOW']) {
      const seen: string[] = []; let page = 1, more = true, guard = 0;
      while (more && guard++ < 6) { r = await call(`/products/${Page.code}/reviews?sort=${sort}&page=${page++}`); seen.push(...r.body.data.reviews.map((x: any) => x.id)); more = r.body.data.hasMore; }
      check(`27 reviews from one instant, sorted ${sort}: every one once across the pages`, seen.length === 27 && new Set(seen).size === 27, { seen: seen.length, unique: new Set(seen).size });
    }
    r = await call(`/products/${Page.code}/reviews?rating=3`);
    check('filtered: counts stay the whole item\'s', r.body?.data?.summary?.count === 27 && r.body?.data?.reviews?.every((x: any) => x.rating === 3), r.body?.data?.summary);
    for (const q of ['page=0', 'page=-5', 'page=abc', 'page=99999999999', 'rating=0', 'rating=abc', 'sort=DROP']) {
      r = await call(`/products/${Page.code}/reviews?${q}`);
      check(`?${q}: an answer, no crash`, r.status === 200 && Array.isArray(r.body?.data?.reviews), r.status);
    }
    const Race = await product('R'); await deliver(await order(P1, Race));
    const raced = await Promise.all(Array.from({ length: 8 }, (_, i) => review(Race.code, t1, { rating: (i % 5) + 1 })));
    check('8 saves at once: all answered, one review', raced.every(x => x.status === 200) && await prisma.shopReview.count({ where: { productId: Race.id } }) === 1, raced.map(x => x.status));
    const mixed = await Promise.all([review(Race.code, t1, { rating: 5 }), call(`/products/${Race.code}/reviews/remove`, { token: t1 }), review(Race.code, t1, { rating: 2 }), call(`/products/${Race.code}/reviews/remove`, { token: t1 })]);
    check('saves and removals crossing: no crash', mixed.every(x => x.status === 200 || calm(x)), mixed.map(x => x.status));
    const oF = await order(P1, Race, 'Kavya Reddy'); await deliver(oF);
    const fb = await Promise.all(Array.from({ length: 6 }, (_, i) => call('/reviews/feedback', { orderToken: oF, body: `Note ${i}` })));
    check('6 feedback saves at once: all answered, one row', fb.every(x => x.status === 200) && await prisma.shopOrderFeedback.count({ where: { onlineOrder: { token: oF } } }) === 1, fb.map(x => x.status));

    console.log('\nE. CRM\'S ROUTES, OVER HTTP');
    const owner = await prisma.user.findFirstOrThrow({ where: { clientId: C, email: 'verify-suites@example.com' }, select: { id: true } });
    const nobody = await prisma.user.create({ data: { clientId: C, name: 'No Permissions', email: `nobody-${STAMP}@example.com`, password: await AuthService.hashPassword('x'.repeat(12)), status: 'ACTIVE' as any } as any });
    madeUsers.push(nobody.id);
    const outsider = await prisma.user.findFirst({ where: { clientId: { not: C }, status: 'ACTIVE' }, select: { id: true } });
    const hadSub = await prisma.moduleSubscription.findFirst({ where: { clientId: C, module: 'crm' } });
    const bearer = (claims: any = {}, signWith = privateKey) => ({ Authorization: `Bearer ${jwt.sign({ sub: 'scaleezy-crm-test', scope: claims.scope ?? ['modules:crm'], ...(claims.clientId ? { clientId: claims.clientId } : {}), ...(claims.userId ? { onBehalfOf: { userId: claims.userId } } : {}) }, signWith, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}` });
    const crm = (path: string, method = 'GET', headers: Record<string, string> = bearer(), body?: unknown) => raw(`/api/v1/internal/modules/crm/shops/${C}${path}`, method, body === undefined ? undefined : JSON.stringify(body), { host: '127.0.0.1:4026', ...headers });
    const asOwner = bearer({ clientId: C, userId: owner.id });
    r = await crm('/reviews');
    if (!hadSub) check('CRM not switched on for the shop: refused', r.status === 404, r.status);
    if (!hadSub) await (prisma.moduleSubscription as any).create({ data: { clientId: C, module: 'crm' } });
    const target = await prisma.shopReview.findFirstOrThrow({ where: { productId: A.id } });
    r = await crm('/reviews', 'GET', {});
    check('no token: 401', r.status === 401, r.status);
    r = await crm('/reviews', 'GET', { Authorization: 'Bearer not.a.token' });
    check('a junk token: 401', r.status === 401, r.status);
    const { privateKey: fake } = await import('node:crypto').then(c => c.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }));
    r = await crm('/reviews', 'GET', bearer({}, fake));
    check('a token signed with the wrong key: 401', r.status === 401, r.status);
    r = await crm('/reviews', 'GET', bearer({ scope: ['session:read'] }));
    check('the wrong scope: 403', r.status === 403, r.status);
    r = await crm('/reviews');
    check('the right token: the list, with the number for the shop', r.status === 200 && r.body?.data?.reviews?.some((x: any) => x.id === target.id && x.phone === target.phone), r.status);
    r = await crm(`/reviews/${target.id}/hide`, 'POST', bearer(), { reason: 'SPAM' });
    check('a change with nobody named: refused', r.status === 403, r.status);
    r = await crm(`/reviews/${target.id}/hide`, 'POST', bearer({ clientId: C, userId: nobody.id }), { reason: 'SPAM' });
    check('a person without the permission: refused', r.status === 403, r.status);
    if (outsider) { r = await crm(`/reviews/${target.id}/hide`, 'POST', bearer({ clientId: C, userId: outsider.id }), { reason: 'SPAM' }); check('a person from another shop: refused', r.status === 403, r.status); }
    r = await raw(`/api/v1/internal/modules/crm/shops/some-other-shop/reviews`, 'GET', undefined, { host: '127.0.0.1:4026', ...bearer() });
    check('another shop that has not switched CRM on: refused', r.status === 404, r.status);
    for (const reason of ['', 'LOW_RATING', 'constructor', 'toString', '__proto__', null, 5]) {
      r = await crm(`/reviews/${target.id}/hide`, 'POST', asOwner, { reason });
      check(`hide with reason ${JSON.stringify(reason)}: refused`, r.status === 400 && /Choose why/.test(r.body?.message), r.body ?? r.status);
    }
    check('...and it is still showing', (await prisma.shopReview.findUniqueOrThrow({ where: { id: target.id } })).status === 'PUBLISHED');
    r = await crm('/reviews/00000000-0000-0000-0000-000000000000/hide', 'POST', asOwner, { reason: 'SPAM' });
    check('a review that does not exist: 404', r.status === 404, r.status);
    r = await crm(`/reviews/${target.id}/hide`, 'POST', asOwner, { reason: 'SPAM' });
    check('hidden, in the owner\'s name', r.status === 200 && r.body?.data?.status === 'HIDDEN' && typeof r.body?.data?.hiddenBy === 'string', r.body);
    r = await crm(`/reviews/${target.id}/hide`, 'POST', asOwner, { reason: 'ABUSIVE' });
    check('hidden twice: fine, the new reason stands', r.status === 200 && r.body?.data?.hiddenReason === 'ABUSIVE', r.body);
    await new Promise(x => setTimeout(x, 400));
    check('the activity log names the person', await prisma.auditLog.count({ where: { clientId: C, userId: owner.id, action: 'HIDE_REVIEW', entityId: target.id } }) >= 1);
    r = await crm(`/reviews/${target.id}/unhide`, 'POST', asOwner);
    r = await crm(`/reviews/${target.id}/unhide`, 'POST', asOwner);
    check('un-hidden twice: fine', r.status === 200 && r.body?.data?.status === 'PUBLISHED', r.body);
    r = await crm(`/reviews/${target.id}/reply`, 'POST', asOwner, { text: `<b>Thanks</b> \u0000 ${'z'.repeat(900)}` });
    check('a long hostile reply: kept to 500, plain, no NUL', r.status === 200 && r.body?.data?.reply?.length === 500 && !r.body?.data?.reply.includes('\u0000'), r.body?.data?.reply?.length);
    for (const text of ['', '   ', null, 5, { a: 1 }]) {
      r = await crm(`/reviews/${target.id}/reply`, 'POST', asOwner, { text });
      check(`reply ${JSON.stringify(text)}: refused`, r.status === 400 && /Type your reply/.test(r.body?.message), r.body ?? r.status);
    }
    r = await crm(`/reviews/${target.id}/reply`, 'DELETE', asOwner);
    r = await crm(`/reviews/${target.id}/reply`, 'DELETE', asOwner);
    check('reply removed twice: fine', r.status === 200 && r.body?.data?.reply === null, r.body);
    for (const q of ['limit=99999', 'limit=-1', 'limit=abc', 'cursor=not-an-id', 'status=DROP', 'rating=9', 'needsReply=maybe', 'phone=abc', 'productCode=%27']) {
      r = await crm(`/reviews?${q}`);
      check(`list ?${q}: an answer, no crash`, r.status === 200 && Array.isArray(r.body?.data?.reviews) && r.body.data.reviews.length <= 100, r.status);
    }
    const all: string[] = []; let cursor: string | null = null, guard = 0;
    do { r = await crm(`/reviews?productCode=${Page.code}&limit=10${cursor ? `&cursor=${cursor}` : ''}`); all.push(...r.body.data.reviews.map((x: any) => x.id)); cursor = r.body.data.nextCursor; } while (cursor && guard++ < 6);
    check('CRM pages through 27 from one instant: every one once', all.length === 27 && new Set(all).size === 27, { n: all.length, u: new Set(all).size });
    r = await crm('/feedback/00000000-0000-0000-0000-000000000000/handled', 'POST', asOwner, {});
    check('feedback that does not exist: 404', r.status === 404, r.status);
    r = await crm('/reviews/stats');
    check('stats answer', r.status === 200 && typeof r.body?.data?.count === 'number', r.body);
    const edit = await crm(`/reviews/${target.id}`, 'PUT', asOwner, { body: 'The shop rewriting it' });
    check('no route lets CRM rewrite a customer\'s words', edit.status >= 400 && edit.status < 500 && (await prisma.shopReview.findUniqueOrThrow({ where: { id: target.id } })).body !== 'The shop rewriting it', edit.status);
    if (!hadSub) await (prisma.moduleSubscription as any).deleteMany({ where: { clientId: C, module: 'crm' } });
    await prisma.moduleEvent.deleteMany({ where: { clientId: C, module: 'crm', sourceTable: { in: ['shop_reviews', 'shop_order_feedback'] } } }).catch(() => null);

    console.log('\nF. ERASING');
    await review(A.code, t2, { rating: 3, body: 'To be erased' });
    const up2 = await up(A.code, t2, dataUrl(jpeg));
    await review(A.code, t2, { rating: 3, photos: [up2.body?.data?.url] });
    const oE = await order(P2, A, 'Meena Erase'); await deliver(oE);
    await call('/reviews/feedback', { orderToken: oE, body: 'Please forget me' });
    const person = await prisma.customer.findFirstOrThrow({ where: { clientId: C, phone: `+91${P2}` }, select: { id: true, phone: true } });
    await deleteCustomer(C, person.id, person.phone!.slice(-4));
    check('a customer erased: reviews and feedback gone', await prisma.shopReview.count({ where: { clientId: C, phone: { endsWith: P2 } } }) === 0 && await prisma.shopOrderFeedback.count({ where: { clientId: C, phone: { endsWith: P2 } } }) === 0);
    await new Promise(x => setTimeout(x, 500));
    check('...and their photo is gone from storage', [400, 404].includes((await fetch(up2.body?.data?.url)).status), up2.body?.data?.url);
    r = await call(`/products/${A.code}/reviews`);
    check('...and the average no longer counts them', !r.body?.data?.reviews?.some((x: any) => x.body === 'To be erased'), r.body?.data?.summary);

    await prisma.clientSettings.create({ data: { clientId: other, businessName: 'Throwaway', timezone: 'Asia/Kolkata' } as any }).catch(() => null);
    const op = await prisma.product.create({ data: { clientId: other, productCode: `RWX${STAMP}`, slug: `rwx${STAMP}`, title: 'X', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1, status: 'ACTIVE' as any } as any });
    const path = `reviews/${other}/44444444-4444-4444-4444-444444444444.jpg`;
    await supabase.storage.from('inventory-images').upload(path, jpeg, { contentType: 'image/jpeg', upsert: true });
    const publicUrl = supabase.storage.from('inventory-images').getPublicUrl(path).data.publicUrl;
    await prisma.shopReview.create({ data: { clientId: other, productId: op.id, phone: '+919000000000', rating: 5, photos: [{ url: publicUrl, path }] } });
    await platformAdminService.deleteClientCompletely(other, other);
    check('a whole shop deleted: its reviews gone', await prisma.shopReview.count({ where: { clientId: other } }) === 0);
    check('...and their photos too', [400, 404].includes((await fetch(publicUrl)).status));

    console.log('\nG. SIGNING IN');
    const email = `Worst.User${STAMP}@Example.com`, lower = email.toLowerCase(), pw = readablePassword();
    const u = await prisma.user.create({ data: { clientId: C, name: 'Worst', email: lower, password: await AuthService.hashPassword(pw), status: 'ACTIVE' as any } as any }); madeUsers.push(u.id);
    const login = (b: unknown) => api('/auth/login', 'POST', b);
    check('generated passwords: 12 long, no look-alikes, over 2,000 of them', Array.from({ length: 2000 }, () => readablePassword()).every(x => /^[A-HJKMNP-Za-hjkmnp-z2-9]{12}$/.test(x)));
    check('...and none repeated', new Set(Array.from({ length: 2000 }, () => readablePassword())).size === 2000);
    for (const [label, e] of [['exact', lower], ['with capitals', email], ['ALL CAPS', lower.toUpperCase()], ['with spaces', `  ${lower}\t`]] as const) {
      r = await login({ email: e, password: pw });
      check(`email ${label}: signs in`, r.status === 200 && r.body?.success === true, r.body);
    }
    r = await login({ email: lower, password: `${pw} ` }); check('a space after the password: signs in', r.status === 200 && r.body?.success === true, r.body);
    r = await login({ email: lower, password: `  ${pw}\n` }); check('spaces and a new line round it: signs in', r.status === 200 && r.body?.success === true, r.body);
    r = await login({ email: lower, password: pw.toLowerCase() === pw ? pw.toUpperCase() : pw.toLowerCase() }); check('the wrong case: refused', r.status === 401, r.status);
    r = await login({ email: lower, password: pw.slice(0, -1) }); check('part of it: refused', r.status === 401, r.status);
    await prisma.$executeRawUnsafe(`DELETE FROM login_failures WHERE false`).catch(() => null);
    const spaced = 'real space pw ';
    const u2 = await prisma.user.create({ data: { clientId: C, name: 'Spaced', email: `spaced${STAMP}@example.com`, password: await AuthService.hashPassword(spaced), status: 'ACTIVE' as any } as any }); madeUsers.push(u2.id);
    r = await login({ email: `spaced${STAMP}@example.com`, password: spaced }); check('a password that really ends in a space: still works exactly', r.status === 200 && r.body?.success === true, r.body);
    r = await login({ email: `spaced${STAMP}@example.com`, password: 'real  space pw' }); check('...spaces inside it still count', r.status === 401, r.status);
    for (const [label, b] of [['an object for an email', { email: { contains: '@' }, password: 'x' }], ['an array', { email: ['a@b.c'], password: 'x' }], ['no email', { password: 'x' }], ['no password', { email: lower }], ['empty both', { email: '', password: '' }], ['an object for a password', { email: lower, password: { a: 1 } }], ['only spaces as a password', { email: lower, password: '   ' }], ['nothing at all', {}]] as const) {
      r = await login(b);
      check(`${label}: refused, no crash, no sign-in`, r.status >= 400 && r.status < 500 && r.body?.success !== true, { s: r.status, b: r.body });
    }
    await prisma.user.update({ where: { id: u2.id }, data: { status: 'INACTIVE' as any } });
    r = await login({ email: `SPACED${STAMP}@example.com`, password: spaced }); check('an inactive user, with capitals: still refused', r.status === 401, r.status);
    for (let i = 0; i < 12; i++) await login({ email: i % 2 ? `throttle${STAMP}@example.com` : `THROTTLE${STAMP}@EXAMPLE.COM`, password: 'wrong' });
    r = await login({ email: `Throttle${STAMP}@example.com`, password: 'wrong' }); check('guessing with changing capitals is still one account: locked', r.status === 429, r.status);
    const admin = await prisma.platformAdmin.create({ data: { email: `worst-admin${STAMP}@example.com`, name: 'Worst Admin', password: await AuthService.hashPassword('correct-horse-battery'), status: 'ACTIVE' as any } as any });
    r = await api('/auth/admin/login', 'POST', { email: `WORST-admin${STAMP}@example.com `, password: 'correct-horse-battery ' });
    if (r.status === 404) r = await api('/admin/auth/login', 'POST', { email: `WORST-admin${STAMP}@example.com `, password: 'correct-horse-battery ' });
    if (r.status === 404) r = await api('/admin/login', 'POST', { email: `WORST-admin${STAMP}@example.com `, password: 'correct-horse-battery ' });
    check('the console\'s sign-in forgives the same things', r.status === 200, { s: r.status, b: r.body });
    await prisma.platformAdmin.delete({ where: { id: admin.id } });

    console.log('\nH. THE PRODUCT LIST');
    for (const q of ['minPrice=5000&maxPrice=100', 'minPrice=-5', 'maxPrice=abc', 'minPrice=', 'maxPrice=0', 'minPrice=1e99', 'maxPrice=99999999999999999999', 'q=%25', 'q=_', 'q=%5C', `q=${'x'.repeat(500)}`, 'q=%27%3B%20DROP%20TABLE%20x', 'q=%F0%9F%98%8D', 'page=-1', 'limit=99999', 'sort=DROP', 'q=saree&minPrice=1&maxPrice=2&sort=PRICE_LOW']) {
      r = await call(`/products?${q}`);
      check(`?${q.slice(0, 40)}: an answer, no crash`, r.status === 200 && Array.isArray(r.body?.data?.products), { s: r.status, m: r.body?.message });
    }
    r = await call('/products?minPrice=5000&maxPrice=100');
    check('a price range upside down: nothing, calmly', r.body?.data?.products?.length === 0, r.body?.data?.total);
  } finally {
    await prisma.onlineShop.update({ where: { id: was.id }, data: { acceptsOrders: was.acceptsOrders, payOnDelivery: was.payOnDelivery, reviews: was.reviews, accounts: was.accounts } });
    await prisma.shopReview.deleteMany({ where: { productId: { in: madeProducts } } });
    await prisma.product.updateMany({ where: { id: { in: madeProducts } }, data: { status: 'ARCHIVED' as any } });
    await prisma.user.deleteMany({ where: { id: { in: madeUsers } } }).catch(() => null);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log('FAILED:\n  ' + failures.join('\n  '));
}
main().catch((e) => { console.error(e); failed++; }).finally(async () => { await prisma.$disconnect(); process.exit(failed ? 1 : 0); });
