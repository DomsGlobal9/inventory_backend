/**
 * Try-on counts per garment and colour (owner, 28 Oct: "how many try-ons for a garment or variant";
 * "we don't need who").
 *
 *   1. The three REAL try-on paths count, through their real routes/functions: the QR on the tag
 *      (public route), the counter (staff route) and the online shop (seeItOn). Only the paid
 *      gateway and the photo storage are stood in for.
 *   2. Exact numbers: completed vs failed, per colour (a colour spans sizes), per place; a refusal
 *      before the try-on started (no photograph, unknown garment, out of allowance) is NOT a try-on.
 *   3. Honest colour: the colour of the photograph worn, so a tag naming a colour with no photograph
 *      of its own counts as "colour unknown", not as that colour.
 *   4. The product page numbers (GET /products/:id/try-ons) next to units sold of the same colour,
 *      and "most tried, least bought" (fewer than 3 tries left out, ordered by how rarely a try-on
 *      became a sale, a cancelled bill not a sale, a binned product left out).
 *   5. No person anywhere: the table has no column that could hold one, and the shopper's reply
 *      carries no product id.
 *
 * LOCAL DATABASE ONLY.
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory npx tsx src/scripts/verify-garment-tryons.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || process.env.DATABASE_URL).includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL/DIRECT_URL must point at the local copy (${LOCAL}).`);
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
const C = `garment-tryons-${STAMP}`;
const DAY = 86_400_000;

/** The paid gateway, stood in: answers ok, or breaks after the try-on started. */
function startGateway() {
  let mode: 'ok' | 'broken' = 'ok';
  let calls = 0;
  return new Promise<{ url: string; calls: () => number; setMode: (m: 'ok' | 'broken') => void; close: () => Promise<void> }>(resolve => {
    const server = http.createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        calls++;
        if (mode === 'broken') { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end('{"error":"gpu fell over"}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, resultImageUrl: 'https://cdn.example/result.jpg', processingTimeMs: 900 }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      calls: () => calls,
      setMode: m => { mode = m; },
      close: () => new Promise(r => server.close(() => r()))
    }));
  });
}

(async () => {
  const gw = await startGateway();
  process.env.SHOPPER_TRYON_GATEWAY_URL = gw.url;
  process.env.SHOPPER_TRYON_API_KEY = 'sk_shared_shopper_key_for_local_test';

  // Imported after the environment is set: env.ts reads it once, at import.
  const express = (await import('express')).default;
  const sharp = (await import('sharp')).default;
  const { prisma } = await import('../lib/prisma');
  const { supabase } = await import('../lib/supabase');
  const publicRoutes = (await import('../routes/shopper-tryon-public.routes')).default;
  const counterRoutes = (await import('../routes/tryon-counter.routes')).default;
  const productRoutes = (await import('../routes/product.routes')).default;
  const shopTryOn = await import('../services/online-shop/tryon');
  const { garmentTryOns } = await import('../services/garment-tryons');

  // The photo storage, stood in: a picture of a person must never reach the real bucket from a test.
  const stored: string[] = [];
  (supabase as any).storage.from = () => ({
    upload: async (path: string) => { stored.push(path); return { error: null }; },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.example/${path}` } }),
    remove: async () => ({ error: null })
  });

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/t', publicRoutes);
  // Signed in as this shop's owner, the way auth + tenant middleware would leave the request.
  app.use((req: any, _res, next) => { req.user = { id: 'owner-test', clientId: C, roles: ['SUPER_ADMIN'], permissions: [] }; req.clientId = C; next(); });
  app.use('/counter', counterRoutes);
  app.use('/products', productRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const get = (path: string) => fetch(`${API}${path}`).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  const photo = (await sharp({ create: { width: 320, height: 480, channels: 3, background: '#a0522d' } }).jpeg().toBuffer()).toString('base64');

  let n = 0;
  const product = (title: string, extra: any = {}) => prisma.product.create({ data: { clientId: C, productCode: `G${STAMP}-${++n}`, slug: `g${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any, ...extra } });
  const variant = (productId: string, colorName: string, size: string) => prisma.productVariant.create({ data: { productId, clientId: C, colorName, size, variantCode: `GV${STAMP}-${++n}`, sku: `GS${STAMP}-${n}`, sellingPrice: 1000 } });
  const image = (productId: string, url: string, o: { variantId?: string; primary?: boolean } = {}) => prisma.productImage.create({ data: { productId, variantId: o.variantId ?? null, url, isPrimary: !!o.primary, imageType: 'GALLERY' as any } as any });
  const store = await prisma.stockLocation.create({ data: { clientId: C, name: `Store ${STAMP}`, code: `GT${STAMP}`, type: 'STORE', active: true } as any });
  const buyer = await prisma.customer.create({ data: { clientId: C, customerCode: `GC-${STAMP}`, name: 'Test Buyer', phone: null } as any });
  const bill = (variants: { id: string }[], o: { status?: string; daysAgo?: number } = {}) => prisma.salesOrder.create({ data: {
    clientId: C, orderNumber: `GSO-${STAMP}-${++n}`, customerId: buyer.id, channel: 'POS' as any, locationId: store.id, status: (o.status ?? 'DISPATCHED') as any,
    subtotal: 1000, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total: 1000 * variants.length, createdAt: new Date(Date.now() - (o.daysAgo ?? 1) * DAY),
    items: { create: variants.map(v => ({ variantId: v.id, quantity: 1, listUnitPrice: 1000, unitPrice: 1000, unitCost: 0, totalPrice: 1000 })) }
  } as any });
  const rows = () => prisma.garmentTryOnDay.findMany({ where: { clientId: C }, orderBy: [{ place: 'asc' }, { colour: 'asc' }] });

  try {
    // A saree in Maroon (one size) and Green (two sizes, one photograph filed under the S); Rani has no photograph.
    const saree = await product('Kanchi Saree');
    const maroon = await variant(saree.id, 'Maroon', 'Free');
    const greenS = await variant(saree.id, 'Green', 'S');
    const greenM = await variant(saree.id, 'Green', 'M');
    const rani = await variant(saree.id, 'Rani', 'Free');
    await image(saree.id, 'https://cdn.example/saree-cover.jpg', { primary: true });
    await image(saree.id, 'https://cdn.example/saree-maroon.jpg', { variantId: maroon.id });
    await image(saree.id, 'https://cdn.example/saree-green.jpg', { variantId: greenS.id });
    const kurti = await product('Linen Kurti');
    await image(kurti.id, 'https://cdn.example/kurti.jpg', { primary: true });
    const stole = await product('Silk Stole');
    await image(stole.id, 'https://cdn.example/stole.jpg', { primary: true });
    const draft = await product('Draft Dupatta', { status: 'DRAFT' });
    await image(draft.id, 'https://cdn.example/draft.jpg', { primary: true });

    console.log('\n1. THE QR ON THE TAG (public route)');
    let r = await post(`/t/${C}/${saree.productCode}/generate`, { humanImageUrl: 'https://cdn.example/me.jpg', variant: maroon.variantCode });
    eq('tag, Maroon: 200', r.status, 200);
    check('the shopper\'s reply carries no product id', !JSON.stringify(r.body).includes(saree.id), r.body);
    r = await post(`/t/${C}/${saree.productCode}/generate`, { humanImageUrl: 'https://cdn.example/me.jpg', variant: rani.variantCode });
    eq('tag, Rani (no photograph of its own, the cover is worn): 200', r.status, 200);
    r = await post(`/t/${C}/${saree.productCode}/generate`, { humanImageUrl: 'http://not-https/me.jpg' });
    eq('tag, no usable photograph: 400 and nothing counted', r.status, 400);
    r = await post(`/t/${C}/NOPE-${STAMP}/generate`, { humanImageUrl: 'https://cdn.example/me.jpg' });
    eq('tag, unknown garment: 404', r.status, 404);
    r = await post(`/t/${C}/${draft.productCode}/generate`, { humanImageUrl: 'https://cdn.example/me.jpg' });
    eq('tag, a draft: 404 (not reachable, not counted)', r.status, 404);
    gw.setMode('broken');
    r = await post(`/t/${C}/${saree.productCode}/generate`, { humanImageUrl: 'https://cdn.example/me.jpg', variant: maroon.variantCode });
    check('tag, gateway broke after starting: an error', r.status >= 500, r.status);
    gw.setMode('ok');

    console.log('\n2. THE COUNTER (staff route)');
    r = await post(`/counter/${saree.id}`, { photo, imageUrl: 'https://cdn.example/saree-green.jpg' });
    eq('counter, the Green photograph: 200', r.status, 200);
    r = await post(`/counter/${saree.id}`, { photo });
    eq('counter, no photograph chosen (the cover): 200', r.status, 200);
    r = await post(`/counter/${saree.id}`, { photo, imageUrl: 'https://elsewhere.example/other-shop.jpg' });
    eq('counter, a picture not of this product falls back to the cover: 200', r.status, 200);
    r = await post(`/counter/${kurti.id}`, {});
    eq('counter, no photograph of the person: 400, not counted', r.status, 400);
    r = await post(`/counter/00000000-0000-0000-0000-000000000000`, { photo });
    eq('counter, not this shop\'s product: 404', r.status, 404);

    console.log('\n3. THE ONLINE SHOP (seeItOn)');
    await prisma.onlineShop.create({ data: { clientId: C, slug: `gt-${STAMP}`, isLive: true, tryOn: true, locationIds: [store.id] } as any });
    const shop = async (code: string, variantCode?: string) => { try { await shopTryOn.seeItOn(C, code, photo, variantCode); return 'ok'; } catch (e: any) { return e?.message ?? 'error'; } };
    // Green M has no photograph of its own; the Green one filed under S is the same colour.
    eq('shop, Green in size M: tried on', await shop(saree.productCode, greenM.variantCode), 'ok');
    eq('shop, Kurti (no colours): tried on', await shop(kurti.productCode), 'ok');
    eq('shop, Kurti again', await shop(kurti.productCode), 'ok');
    gw.setMode('broken');
    check('shop, gateway broke: refused with a sentence', (await shop(kurti.productCode)) !== 'ok');
    gw.setMode('ok');
    await new Promise(r2 => setTimeout(r2, 300));   // the counts are written after the answer, never awaited

    console.log('\n4. WHAT WAS COUNTED, EXACTLY');
    const got = (await rows()).map(x => [x.place, x.productId === saree.id ? 'saree' : x.productId === kurti.id ? 'kurti' : x.productId, x.colour, x.completed, x.failed]);
    eq('rows: per place, garment and colour', got, [
      ['COUNTER', 'saree', '', 2, 0],          // the cover twice (no photograph chosen; a foreign picture refused)
      ['COUNTER', 'saree', 'Green', 1, 0],
      ['SHOP_PAGE', 'kurti', '', 2, 1],
      ['SHOP_PAGE', 'saree', 'Green', 1, 0],   // asked for Green M, wore the Green photograph: Green
      ['TAG', 'saree', '', 1, 0],              // Rani asked, cover worn: colour unknown, not "Rani"
      ['TAG', 'saree', 'Maroon', 1, 1]
    ]);
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'garment_tryon_days' ORDER BY ordinal_position`;
    eq('the table has no column that could hold a person', cols.map(c2 => c2.column_name), ['client_id', 'product_id', 'colour', 'day', 'place', 'completed', 'failed']);
    eq('the photographs went to the stand-in storage only (3 counter + 4 shop)', stored.length, 7);

    console.log('\n5. THE PRODUCT PAGE NUMBERS');
    await bill([maroon]);                      // a Maroon sold
    await bill([greenS, greenM]);              // two Greens sold (sizes S and M are one colour)
    await bill([maroon], { status: 'CANCELLED' });   // not a sale
    await bill([maroon], { daysAgo: 40 });     // outside the 30 days
    let p = await get(`/products/${saree.id}/try-ons`);
    eq('saree: 200', p.status, 200);
    eq('saree: tried on 6 times in 30 days, 1 broken', [p.body.data.days, p.body.data.triedOn, p.body.data.failed], [30, 6, 1]);
    eq('saree: by place', p.body.data.places, { TAG: 2, SHOP_PAGE: 1, COUNTER: 3 });
    eq('saree: by colour, most tried first, with that colour\'s sales', p.body.data.byColour, [
      { colour: null, triedOn: 3, sold: 0 },
      { colour: 'Green', triedOn: 2, sold: 2 },
      { colour: 'Maroon', triedOn: 1, sold: 1 }
    ]);
    p = await get(`/products/${stole.id}/try-ons`);
    eq('never tried: zeros, no colours', [p.body.data.triedOn, p.body.data.byColour], [0, []]);
    p = await get(`/products/${saree.id}/try-ons?days=abc`);
    eq('a nonsense period is 30 days', p.body.data.days, 30);
    p = await get(`/products/${saree.id}/try-ons?days=99999`);
    eq('a huge period is capped at a year', p.body.data.days, 365);
    const other = await garmentTryOns.forProduct(`someone-else-${STAMP}`, saree.id);
    eq('another shop asking for this garment sees nothing', other.triedOn, 0);

    console.log('\n6. MOST TRIED, LEAST BOUGHT');
    // The kurti: 2 tries, under the 3 needed. Give it a third, then it qualifies with no sale.
    eq('shop, Kurti a third time', await shop(kurti.productCode), 'ok');
    // The stole: 4 tries and 4 sold -- popular AND bought, last.
    // (at the counter: the public tag allows 8 generations per 10 minutes per address, and this suite already used 6)
    for (let i = 0; i < 4; i++) await post(`/counter/${stole.id}`, { photo });
    const stoleV = await variant(stole.id, '', 'Free');
    for (let i = 0; i < 4; i++) await bill([stoleV]);
    await new Promise(r2 => setTimeout(r2, 300));
    let m = await get(`/products/try-ons/most-tried`);
    eq('most tried: 200', m.status, 200);
    eq('order: never bought first, then by how rarely a try-on sold', m.body.data.items.map((i: any) => [i.title, i.triedOn, i.sold]), [
      ['Linen Kurti', 3, 0], ['Kanchi Saree', 6, 3], ['Silk Stole', 4, 4]
    ]);
    check('each item carries its picture', m.body.data.items.every((i: any) => typeof i.imageUrl === 'string'), m.body.data.items);
    await prisma.product.update({ where: { id: kurti.id }, data: { trashedAt: new Date() } });
    m = await get(`/products/try-ons/most-tried?limit=1`);
    eq('a binned product is left out; limit honoured', m.body.data.items.map((i: any) => i.title), ['Kanchi Saree']);
    await prisma.product.update({ where: { id: kurti.id }, data: { trashedAt: null } });
    eq('a shop with no try-ons: an empty list', (await garmentTryOns.mostTriedLeastBought(`nobody-${STAMP}`)).items, []);

    console.log('\n7. WORST CASES');
    // Twenty try-ons of one colour at once: one row, exactly twenty.
    await Promise.all(Array.from({ length: 20 }, () => garmentTryOns.record(C, { productId: stole.id, colour: 'Gold' }, 'COUNTER', true)));
    const gold = await prisma.garmentTryOnDay.findMany({ where: { clientId: C, productId: stole.id, colour: 'Gold' } });
    eq('20 at once: one row, completed 20', gold.map(g => g.completed), [20]);
    // A colour name with quotes, a backslash and a percent sign is stored as written.
    await garmentTryOns.record(C, { productId: stole.id, colour: `Rose 'n' \\ 100%` }, 'COUNTER', true);
    const odd = await prisma.garmentTryOnDay.findFirst({ where: { clientId: C, colour: `Rose 'n' \\ 100%` } });
    check('an odd colour name is kept as written', odd?.completed === 1, odd);
    // A broken database must not break a try-on: record() never throws.
    let threw = false;
    try { await garmentTryOns.record(C, { productId: 'x'.repeat(10) }, 'NOT_A_PLACE' as any, true); } catch { threw = true; }
    check('record() never throws', !threw);
    // Nothing to count: no product id.
    await garmentTryOns.record(C, null, 'TAG', true);
    await garmentTryOns.record('', { productId: saree.id }, 'TAG', true);
    check('nothing counted without a shop or a garment', (await prisma.garmentTryOnDay.count({ where: { productId: saree.id, clientId: '' } })) === 0);
    eq('the gateway was called once per try-on that started, refusals never reached it', gw.calls(), 15);
  } catch (e: any) {
    console.error(e);
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).trim().split('\n')[0]})`, false);
  } finally {
    const w = { clientId: C };
    await prisma.garmentTryOnDay.deleteMany({ where: w }).catch(e => console.log('left counts', e.message));
    await prisma.onlineShop.deleteMany({ where: w }).catch(e => console.log('left shop', e.message));
    await prisma.salesOrderItem.deleteMany({ where: { salesOrder: w } }).catch(e => console.log('left items', e.message));
    await prisma.salesOrder.deleteMany({ where: w }).catch(e => console.log('left orders', e.message));
    await prisma.productImage.deleteMany({ where: { product: w } }).catch(e => console.log('left images', e.message));
    await prisma.productVariant.deleteMany({ where: w }).catch(e => console.log('left variants', e.message));
    await prisma.product.deleteMany({ where: w }).catch(e => console.log('left products', e.message));
    await prisma.customer.deleteMany({ where: w }).catch(e => console.log('left customers', e.message));
    await prisma.stockLocation.deleteMany({ where: w }).catch(e => console.log('left locations', e.message));
    await prisma.tryOnUsage.deleteMany({ where: w }).catch(e => console.log('left usage', e.message));
    server.close();
    await gw.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
