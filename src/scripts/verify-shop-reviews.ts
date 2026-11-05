/**
 * Customer reviews and private feedback (5 Nov, services/shop-reviews), over the REAL shop routes on a local server
 * (4026), and CRM's side through the same service its /internal routes call.
 *   1. who may review: only the number whose order of this item was delivered; never a stranger or an undelivered order;
 *   2. what is checked: stars, length, tags, photos (only uploaded ones, re-drawn, three at most, never someone else's);
 *   3. what the public sees: the average, the page, no number anywhere; one review per item, editable, removable;
 *   4. CRM: reply and hide (with a reason); hidden leaves the page and the average; the shop cannot rewrite a review;
 *   5. private feedback never reaches the product page;
 *   6. events reach CRM's outbox; deleting a customer deletes their reviews and feedback; a shop can switch reviews off.
 *
 * LOCAL DATABASE AND STORAGE STAND-IN ONLY. Its own products and numbers on the test shop, removed at the end.
 *   Needs reviews-backend-4026.mjs and the storage stand-in on 18200 running.
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
if (!String(process.env.SUPABASE_URL || '').includes('127.0.0.1:18200')) {
  console.error('Refusing to run: SUPABASE_URL must be the local storage stand-in, so no test photo reaches real storage.');
  process.exit(2);
}
import fs from 'node:fs';
import http from 'node:http';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import * as reviews from '../services/shop-reviews';
import { dispatchService } from '../services/dispatch.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};
const C = 'verify-suites-tenant', SLUG = 'localshop';
const LOCATION = '0e3adb72-1143-4b80-b92b-bbbb2612fe19';
const STAMP = String(Date.now()).slice(-6);
const CODES = 'C:/Users/HP/AppData/Local/Temp/claude/D--villy-inventory/9bd5afd2-c77c-4f44-bec2-3d5913e47e09/scratchpad/codes.jsonl';
const P1 = `90010${STAMP.slice(-5)}`, P2 = `90020${STAMP.slice(-5)}`, P3 = `90030${STAMP.slice(-5)}`;
const plus = (p: string) => `+91${p}`;

/** Through the shop's own host, as a browser reaches it: fetch cannot set Host. */
const call = (path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: 4026, path: `/_api/shop/${SLUG}${path}`, method: body === undefined ? 'GET' : 'POST',
    headers: { host: 'shop.localhost:4006', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c; });
    res.on('end', () => { let parsed = null; try { parsed = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, body: parsed }); });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const codeFor = async (phone: string, after: number) => {
  for (let i = 0; i < 80; i++) {
    const rows = fs.readFileSync(CODES, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => String(l.to).endsWith(phone)).slice(after);
    const m = /(\d{6}) is your code/.exec(rows.at(-1)?.text ?? '');
    if (m) return m[1];
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`no code for ${phone}`);
};
const sentTo = (phone: string) => fs.readFileSync(CODES, 'utf8').trim().split('\n').filter(Boolean).filter(l => String(JSON.parse(l).to).endsWith(phone)).length;
const prove = async (phone: string) => {
  const before = sentTo(phone);
  const s = await call('/verify/send', { phone, purpose: 'SIGNIN' });
  if (s.status !== 200) throw new Error(`code not sent: ${JSON.stringify(s.body)}`);
  const ok = await call('/verify/check', { phone, code: await codeFor(phone, before) });
  if (ok.status !== 200) throw new Error(`code refused: ${JSON.stringify(ok.body)}`);
  return ok.body.data.token as string;
};

async function main() {
  const was = await prisma.onlineShop.findFirstOrThrow({ where: { clientId: C }, select: { id: true, acceptsOrders: true, payOnDelivery: true, reviews: true, accounts: true } });
  await prisma.onlineShop.update({ where: { id: was.id }, data: { acceptsOrders: true, payOnDelivery: true, reviews: true, accounts: true } });
  const made: string[] = [];
  let n = 0;
  const product = async (tag: string) => {
    const p = await prisma.product.create({ data: { clientId: C, productCode: `RV${STAMP}-${tag}`, slug: `rv${STAMP}-${tag}`.toLowerCase(), title: `Review ${tag} ${STAMP}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date() } as any });
    made.push(p.id);
    const v = await prisma.productVariant.create({ data: { productId: p.id, clientId: C, colorName: 'Red', size: 'M', variantCode: `RVV${STAMP}-${tag}`, sku: `RVS${STAMP}-${tag}`, sellingPrice: 1000, costPrice: 1, reorderLevel: 0 } as any });
    await prisma.inventoryStock.create({ data: { clientId: C, variantId: v.id, locationId: LOCATION, quantity: 20, reservedQty: 0 } });
    return { code: p.productCode, id: p.id, v };
  };
  const order = async (phone: string, item: { v: { variantCode: string } }, name = 'Kavya Reddy') => {
    const r = await call('/orders', { placementKey: `review-suite-${STAMP}-${++n}`, lines: [{ variantCode: item.v.variantCode, quantity: 1 }], name, phone, email: '', address: 'Flat 4, 12-3 Gandhi Road, Vijayawada', pincode: '520001', payWay: 'ON_DELIVERY' });
    if (r.status !== 200) throw new Error(`order refused: ${JSON.stringify(r.body)}`);
    return r.body.data.token as string;
  };
  const deliver = async (token: string) => {
    const row = await prisma.onlineShopOrder.findUniqueOrThrow({ where: { token }, select: { salesOrderId: true, salesOrder: { select: { items: { select: { id: true, quantity: true } } } } } });
    const sent: any = await prisma.$transaction(tx => dispatchService.dispatchInTransaction(tx, C, row.salesOrderId, row.salesOrder.items.map(i => ({ salesOrderItemId: i.id, quantity: i.quantity })), {}), { timeout: 30000, maxWait: 15000 });
    await prisma.dispatch.update({ where: { id: sent.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
  };
  const png = await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#7a1f3d' } }).withMetadata({ exif: { IFD0: { Copyright: 'SECRET-EXIF-MARK' } } }).jpeg().toBuffer();
  const photo = `data:image/jpeg;base64,${png.toString('base64')}`;
  const uploaded: string[] = [];

  try {
    const A = await product('A'), B = await product('B');

    console.log('\n1. WHO MAY REVIEW');
    let r = await call(`/products/${A.code}/reviews`, { token: 'nothing', rating: 5 });
    check('no proof: refused, in a sentence', r.status === 400 && /Sign in/.test(r.body?.message), r.body);
    const t1 = await prove(P1), t2 = await prove(P2);
    r = await call(`/products/${A.code}/reviews`, { token: t1, rating: 5 });
    check('proved, but never bought it: refused', r.status === 400 && /delivered/.test(r.body?.message), r.body);
    r = await call(`/products/${A.code}/reviews/mine`, { token: t1 });
    check('...and the page is told not to offer it', r.body?.data?.signedIn === true && r.body?.data?.canReview === false, r.body);
    const o1 = await order(P1, A);
    r = await call(`/products/${A.code}/reviews`, { token: t1, rating: 5 });
    check('ordered but not delivered: refused', r.status === 400 && /delivered/.test(r.body?.message), r.body);
    await deliver(o1);
    r = await call(`/products/${A.code}/reviews/mine`, { token: t1 });
    check('delivered: may review', r.body?.data?.canReview === true && r.body?.data?.review === null, r.body);
    r = await call(`/products/${B.code}/reviews`, { token: t1, rating: 5 });
    check('delivered one item: still cannot review another', r.status === 400, r.body);
    r = await call(`/products/${A.code}/reviews`, { token: t2, rating: 1, body: 'A rival writing' });
    check('another number: cannot review what it did not buy', r.status === 400, r.body);
    r = await call(`/products/${A.code}/reviews/photo`, { token: t2, photo });
    check('...nor upload a photo for it', r.status === 400 && /delivered/.test(r.body?.message), r.body);

    console.log('\n2. WHAT IS CHECKED');
    for (const bad of [0, 6, 3.5, 'five', null]) {
      r = await call(`/products/${A.code}/reviews`, { token: t1, rating: bad });
      check(`rating ${JSON.stringify(bad)}: refused`, r.status === 400 && /1 to 5/.test(r.body?.message), r.body);
    }
    r = await call(`/products/${A.code}/reviews/photo`, { token: t1, photo: 'data:image/png;base64,bm90IGEgcGljdHVyZQ==' });
    check('a file that is not a picture: refused, in a sentence', r.status === 400 && /could not be read/.test(r.body?.message), r.body);
    r = await call(`/products/${A.code}/reviews/photo`, { token: t1, photo });
    check('a photo uploads', r.status === 200 && !!r.body?.data?.url, r.body);
    const url1: string = r.body?.data?.url ?? '';
    check('...to the storage stand-in, not real storage', url1.includes('127.0.0.1:18200'), url1);
    uploaded.push(url1);
    const stored = Buffer.from(await (await fetch(url1)).arrayBuffer());
    check('...re-drawn: the hidden data in the file is gone', stored.length > 0 && !stored.includes('SECRET-EXIF-MARK') && png.includes('SECRET-EXIF-MARK'));
    const meta = await sharp(stored).metadata();
    check('...and it is a JPEG', meta.format === 'jpeg', meta.format);
    r = await call(`/products/${A.code}/reviews`, { token: t1, rating: 5, photos: ['https://evil.example/x.jpg'] });
    check('a photo from elsewhere: refused', r.status === 400 && /photos/.test(r.body?.message), r.body);
    const more = await Promise.all([1, 2, 3].map(() => call(`/products/${A.code}/reviews/photo`, { token: t1, photo })));
    r = await call(`/products/${A.code}/reviews`, { token: t1, rating: 5, photos: [url1, ...more.map(m => m.body?.data?.url)] });
    check('more than three photos: refused', r.status === 400 && /up to 3/.test(r.body?.message), r.body);

    console.log('\n3. WHAT THE PUBLIC SEES');
    r = await call(`/products/${A.code}/reviews`);
    check('nothing yet: an empty summary', r.status === 200 && r.body?.data?.summary?.count === 0 && r.body?.data?.summary?.average === null, r.body?.data?.summary);
    r = await call(`/products/${A.code}/reviews`, { token: t1, rating: 5, body: `  Lovely zari.\n\n\n\nWorth it. <script>x</script> call ${P1}  `, tags: ['Good quality', 'Not a real tag'], photos: [url1], variantCode: A.v.variantCode });
    check('saved', r.status === 200 && r.body?.data?.summary?.count === 1 && r.body?.data?.summary?.average === 5, r.body);
    r = await call(`/products/${A.code}/reviews`);
    let list = r.body?.data;
    const first = list?.reviews?.[0];
    check('shown: stars, tidy text, the one real tag, the photo', first?.rating === 5 && first?.tags?.join() === 'Good quality' && first?.photos?.[0] === url1 && !/\n{3}/.test(first?.body), first);
    check('name: first name and initial, marked verified', first?.name === 'Kavya R' && first?.verified === true, first);
    check('the size and colour are from the order', first?.variant === 'Red, M', first);
    const row = await prisma.shopReview.findFirstOrThrow({ where: { productId: A.id } });
    check('nothing in the public answer says which number wrote it', !JSON.stringify(list).includes(row.phone) && !('phone' in first), Object.keys(first ?? {}));
    r = await call(`/products/${A.code}/reviews`, { token: t1, rating: 4, body: 'Changed my mind a little', photos: [] });
    check('second save: changes the same review, not a second one', r.status === 200 && r.body?.data?.summary?.count === 1 && r.body?.data?.summary?.average === 4, r.body);
    const row2 = await prisma.shopReview.findFirstOrThrow({ where: { productId: A.id } });
    check('...marked edited, and the same row', row2.id === row.id && !!row2.editedAt);
    const gone = await fetch(url1);
    check('...the photo taken off is deleted from storage', gone.status === 404 || gone.status === 400, gone.status);

    const raced = await product('R'); const oR = await order(P1, raced); await deliver(oR);
    const both = await Promise.all([1, 2, 3, 4].map(k => call(`/products/${raced.code}/reviews`, { token: t1, rating: k })));
    check('four saves racing: one review, no error', both.every(x => x.status === 200) && await prisma.shopReview.count({ where: { productId: raced.id } }) === 1, both.map(x => x.status));

    const o2 = await order(P2, A, 'Meena'); await deliver(o2);
    await call(`/products/${A.code}/reviews`, { token: t2, rating: 2, body: 'Shorter than shown' });
    const o3 = await order(P3, A, 'Anita Prasad Rao'); await deliver(o3);
    const t3 = await prove(P3);
    await call(`/products/${A.code}/reviews`, { token: t3, rating: 5 });
    r = await call(`/products/${A.code}/reviews`);
    list = r.body?.data;
    check('three reviews: 11 stars / 3 = 3.7, and the bars count them', list?.summary?.average === 3.7 && list?.summary?.count === 3 && list?.summary?.counts?.[5] === 1 && list?.summary?.counts?.[4] === 1 && list?.summary?.counts?.[2] === 1, list?.summary);
    check('names: one word stays one word, last initial otherwise', list?.reviews?.some((x: any) => x.name === 'Meena') && list?.reviews?.some((x: any) => x.name === 'Anita R'), list?.reviews?.map((x: any) => x.name));
    r = await call(`/products/${A.code}/reviews?rating=2`);
    check('filter by stars', r.body?.data?.reviews?.length === 1 && r.body?.data?.reviews?.[0]?.rating === 2, r.body?.data?.reviews);
    r = await call(`/products/${A.code}/reviews?sort=LOW`);
    check('sort lowest first', r.body?.data?.reviews?.[0]?.rating === 2, r.body?.data?.reviews?.map((x: any) => x.rating));
    r = await call(`/products/${A.code}/reviews?sort=HIGH&rating=9&page=abc`);
    check('nonsense in the address: the normal list, no error', r.status === 200 && r.body?.data?.reviews?.[0]?.rating === 5, r.body);
    r = await call('/products/NOT-A-CODE/reviews');
    check('an item that does not exist: a sentence', r.status === 400 && /could not be found/.test(r.body?.message), r.body);

    console.log('\n4. CRM: REPLY AND HIDE');
    const rev2 = await prisma.shopReview.findFirstOrThrow({ where: { productId: A.id, rating: 2 } });
    let stats = await reviews.crm.stats(C);
    check('stats include needing a reply', stats.count >= 3 && stats.needsReply >= 1, stats);
    let page = await reviews.crm.list(C, { needsReply: 'true', productCode: A.code });
    check('needs a reply: the low one, with its number for the shop', page.reviews.length === 1 && page.reviews[0].id === rev2.id && page.reviews[0].phone === rev2.phone, page.reviews.map(x => x.rating));
    const byNumber = await reviews.crm.list(C, { phone: P2 });
    check('a customer\'s reviews, by number', byNumber.reviews.length === 1 && byNumber.reviews[0].id === rev2.id, byNumber.reviews.length);
    await reviews.crm.reply(C, rev2.id, '  We are sorry. Please message us and we will sort it out.  ', 'Satish');
    r = await call(`/products/${A.code}/reviews?rating=2`);
    check('the reply shows on the shop', r.body?.data?.reviews?.[0]?.reply?.text === 'We are sorry. Please message us and we will sort it out.', r.body?.data?.reviews?.[0]?.reply);
    page = await reviews.crm.list(C, { needsReply: 'true', productCode: A.code });
    check('...and it no longer needs a reply', page.reviews.length === 0);
    await reviews.crm.reply(C, rev2.id, 'Edited reply', 'Satish');
    check('the reply can be changed', (await prisma.shopReview.findUniqueOrThrow({ where: { id: rev2.id } })).reply === 'Edited reply');
    const refused = async (fn: () => Promise<unknown>) => fn().then(() => null, e => String(e?.message ?? e));
    check('an empty reply: refused', /Type your reply/.test(await refused(() => reviews.crm.reply(C, rev2.id, '   ', 'x')) ?? ''));
    check('hide with no reason: refused, listing the reasons', /Abusive/.test(await refused(() => reviews.crm.hide(C, rev2.id, '', 'x')) ?? ''));
    check('hide because it is a bad review: not a reason', /Choose why/.test(await refused(() => reviews.crm.hide(C, rev2.id, 'LOW_RATING', 'x')) ?? ''));
    check('another shop\'s review: not found', /could not be found/.test(await refused(() => reviews.crm.hide('some-other-shop', rev2.id, 'SPAM', 'x')) ?? ''));
    check('CRM has no way to change the words', !('edit' in reviews.crm) && !('update' in reviews.crm));
    await reviews.crm.hide(C, rev2.id, 'SPAM', 'Satish');
    r = await call(`/products/${A.code}/reviews`);
    check('hidden: off the page and out of the average: (4 + 5) / 2 = 4.5', r.body?.data?.summary?.count === 2 && r.body?.data?.summary?.average === 4.5 && !r.body?.data?.reviews?.some((x: any) => x.id === rev2.id), r.body?.data?.summary);
    r = await call(`/products/${A.code}/reviews/mine`, { token: t2 });
    check('...the writer is told, and still sees it', r.body?.data?.review?.hidden === true, r.body?.data);
    r = await call(`/products/${A.code}/reviews`, { token: t2, rating: 5, body: 'Trying to come back' });
    check('...editing does not put a hidden review back', r.status === 200 && r.body?.data?.hidden === true && (await prisma.shopReview.findUniqueOrThrow({ where: { id: rev2.id } })).status === 'HIDDEN', r.body);
    await reviews.crm.unhide(C, rev2.id);
    r = await call(`/products/${A.code}/reviews`);
    check('un-hidden: back on the page', r.body?.data?.summary?.count === 3 && r.body?.data?.reviews?.some((x: any) => x.id === rev2.id), r.body?.data?.summary);
    check('hide reasons are listed for CRM', reviews.crm.hideReasons().length === 4);

    r = await call(`/products/${A.code}/reviews/remove`, { token: t3 });
    check('the writer takes theirs down, for good', r.status === 200 && r.body?.data?.removed === true && r.body?.data?.summary?.count === 2, r.body);

    console.log('\n5. PRIVATE FEEDBACK');
    r = await call('/reviews/feedback', { orderToken: o1, body: '   ' });
    check('empty: refused', r.status === 400 && /Type your feedback/.test(r.body?.message), r.body);
    const notYet = await order(P1, B);
    r = await call('/reviews/feedback', { orderToken: notYet, body: 'Too soon' });
    check('not delivered yet: refused', r.status === 400 && /delivered/.test(r.body?.message), r.body);
    r = await call('/reviews/feedback', { orderToken: 'a-made-up-link-that-is-long-enough', body: 'Hello' });
    check('a made-up order link: refused', r.status === 400, r.body);
    r = await call('/reviews/feedback', { orderToken: o1, body: 'PRIVATE-NOTE courier should call first' });
    check('sent', r.status === 200, r.body);
    r = await call('/reviews/feedback', { orderToken: o1, body: 'PRIVATE-NOTE changed' });
    check('sent again: the same one, changed', r.status === 200 && await prisma.shopOrderFeedback.count({ where: { body: { startsWith: 'PRIVATE-NOTE' }, clientId: C, phone: { endsWith: P1 } } }) === 1, r.body);
    r = await call('/reviews/order', { orderToken: o1 });
    check('the order page reads it back, with its ratings', r.body?.data?.feedback === 'PRIVATE-NOTE changed' && r.body?.data?.ratings?.[A.code] === 4 && r.body?.data?.delivered === true, r.body?.data);
    r = await call(`/products/${A.code}/reviews`);
    check('it never reaches the product page', !JSON.stringify(r.body).includes('PRIVATE-NOTE'));
    const fb = await reviews.crm.feedback(C, { open: 'true', phone: P1 });
    check('CRM sees it, with the order number and the name', fb.feedback.length === 1 && fb.feedback[0].orderNumber?.startsWith('SO-') === true && fb.feedback[0].customerName === 'Kavya Reddy', fb.feedback[0]);
    await reviews.crm.setFeedbackHandled(C, fb.feedback[0].id, true, 'Satish');
    check('handled: leaves the open list', (await reviews.crm.feedback(C, { open: 'true', phone: P1 })).feedback.length === 0);
    await call('/reviews/feedback', { orderToken: o1, body: 'PRIVATE-NOTE and another thing' });
    check('the customer adds more: open again', (await reviews.crm.feedback(C, { open: 'true', phone: P1 })).feedback.length === 1);

    console.log('\n6. CRM HEARS OF IT; ERASING; THE SWITCH');
    const sub = await prisma.moduleSubscription.findFirst({ where: { clientId: C, module: 'crm' } }).catch(() => null);
    const hadSub = !!sub;
    if (!hadSub) await (prisma.moduleSubscription as any).create({ data: { clientId: C, module: 'crm' } });
    const since = new Date();
    const o4 = await order(P3, B, 'Anita Prasad Rao'); await deliver(o4);
    const r4 = await call(`/products/${B.code}/reviews`, { token: t3, rating: 3, body: 'Outbox check' });
    const rev4 = r4.body?.data?.id as string;
    await reviews.crm.hide(C, rev4, 'SPAM', 'Satish');
    await call('/reviews/feedback', { orderToken: o4, body: 'Outbox feedback' });
    const kinds = (await prisma.moduleEvent.findMany({ where: { clientId: C, module: 'crm', createdAt: { gte: since }, sourceTable: { in: ['shop_reviews', 'shop_order_feedback'] } }, select: { kind: true } })).map(e => e.kind).sort();
    check('review.created, review.updated and feedback.created all reach CRM', kinds.includes('review.created') && kinds.includes('review.updated') && kinds.includes('feedback.created'), kinds);
    await prisma.moduleEvent.deleteMany({ where: { clientId: C, module: 'crm', createdAt: { gte: since } } });
    if (!hadSub) await (prisma.moduleSubscription as any).deleteMany({ where: { clientId: C, module: 'crm' } });

    const { deleteCustomer } = await import('../services/customer-delete') as any;
    const person = await prisma.customer.findFirst({ where: { clientId: C, phone: plus(P2) }, select: { id: true, name: true, phone: true } });
    if (person && deleteCustomer) {
      await deleteCustomer(C, person.id, person.phone?.slice(-4)).catch((e: any) => console.log('    (delete refused:', e?.message, ')'));
    }
    const left = await prisma.shopReview.count({ where: { clientId: C, phone: { endsWith: P2 } } });
    check('a customer erased: their reviews go too', !person || !deleteCustomer || left === 0, { person: !!person, fn: !!deleteCustomer, left });

    await prisma.onlineShop.update({ where: { id: was.id }, data: { reviews: false } });
    await new Promise(x => setTimeout(x, 1200));
    r = await call(`/products/${A.code}/reviews`);
    check('a shop that switched reviews off: refused, in a sentence', r.status === 400 && /does not take reviews/.test(r.body?.message), r.body);
    r = await call('');
    check('...and it tells its pages so', r.body?.data?.reviews === false, r.body?.data?.reviews);
    await prisma.onlineShop.update({ where: { id: was.id }, data: { reviews: true } });
  } finally {
    await prisma.onlineShop.update({ where: { id: was.id }, data: { acceptsOrders: was.acceptsOrders, payOnDelivery: was.payOnDelivery, reviews: was.reviews, accounts: was.accounts } });
    await prisma.shopReview.deleteMany({ where: { productId: { in: made } } });
    await prisma.product.updateMany({ where: { id: { in: made } }, data: { status: 'ARCHIVED' as any } });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log('FAILED: ' + failures.join(' | '));
}
main().catch((e) => { console.error(e); failed++; }).finally(async () => { await prisma.$disconnect(); process.exit(failed ? 1 : 0); });
