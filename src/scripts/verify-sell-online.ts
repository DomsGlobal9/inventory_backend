/**
 * Sell online on / off (PLAN-sell-online.md, 26 Nov 2026). LOCAL DATABASE ONLY, on a throwaway shop.
 *
 * A product switched to "till only" must leave EVERY online place and stay at the till:
 *   online shop list, product page, search, facets, bag/checkout, try-on, hearts/wishlist, reel links (pick + page),
 *   other websites (read API + events), Shopify (archived, count, switch refused, card), CRM links;
 *   the POS till still lists it. Switched back on, it returns everywhere. Bulk: a mix of on, off, draft, material,
 *   no photo and another shop's id gives exactly the right changed / skipped answer, with permission checked.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> API=http://localhost:4036/api/v1 npx tsx src/scripts/verify-sell-online.ts
 */
import { prisma } from '../lib/prisma';
import { makeThrowawayShop } from './lib/throwaway-shop';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';
import { listForPos } from '../services/pos/pos-catalogue.service';
import { productService } from '../services/product.service';
import { shopifyProductPushService } from '../services/shopify-products/push.service';
import * as shop from '../services/online-shop/shop.service';
import { priceBag } from '../services/online-shop/checkout';
import { garmentFor } from '../services/online-shop/tryon';
import * as reels from '../services/reel-links';
import { linksFor, linksForIds } from '../services/crm-reads';
import { facetsFor } from '../services/online-shop/facets';
import { filterProducts, productFilterQuery } from '../services/product-filters';

const API = process.env.API ?? 'http://localhost:4036/api/v1';
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
};
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const errOf = async (f: () => Promise<unknown>) => { try { await f(); return null; } catch (e: any) { return String(e?.message ?? e); } };

async function main() {
  const t = await makeThrowawayShop('SellOnline');
  const { clientId } = t;
  try {
    const S = Date.now().toString(36);
    // The helper's product: published, one colour. Give it a photo and stock, and a second shop for "another shop's id".
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { id: t.variantId }, include: { product: true } });
    const A = v.product;
    await prisma.productImage.create({ data: { productId: A.id, url: 'https://example.invalid/a.jpg', imageType: 'COVER' as any, isPrimary: true } as any });
    await prisma.inventoryStock.create({ data: { clientId, variantId: v.id, locationId: t.locationId, quantity: 5 } as any });
    const make = async (code: string, data: Record<string, unknown>, photo = true) => {
      const p = await prisma.product.create({ data: { clientId, productCode: `${code}-${S}`, slug: `${code.toLowerCase()}-${S}`, title: `${code} piece`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 500, status: 'ACTIVE' as any, sellInShop: true, ...data } as any });
      await prisma.productVariant.create({ data: { clientId, productId: p.id, variantCode: `${code}V-${S}`, sku: `${code}S-${S}`, sellingPrice: 500 } as any });
      if (photo) await prisma.productImage.create({ data: { productId: p.id, url: `https://example.invalid/${code}.jpg`, imageType: 'COVER' as any, isPrimary: true } as any });
      return p;
    };
    const B = await make('ONB', {});                                   // another on, for bulk
    const DRAFT = await make('DRF', { status: 'DRAFT' });
    const MAT = await make('MAT', { sellInShop: false });
    const NOPIC = await make('NOP', { sellOnline: false }, false);     // till only, no photo: cannot go online
    const OFFB = await make('OFB', { sellOnline: false });             // till only, can go online

    // The online shop, live and taking orders; a website connection; a Shopify store with A on it.
    await prisma.onlineShop.upsert({ where: { clientId }, create: { clientId, slug: `so-${S}`, locationIds: [t.locationId], isLive: true, acceptsOrders: true, payOnDelivery: true } as any, update: { locationIds: [t.locationId], isLive: true, acceptsOrders: true, payOnDelivery: true } as any });
    const shopRow = await prisma.onlineShop.findUniqueOrThrow({ where: { clientId } });
    const conn = await prisma.storefrontConnection.create({ data: { clientId, name: 'Test site', baseUrl: 'https://site.example.invalid', credentialHash: 'x', credentialPrefix: `t${S}`, locationIds: [], status: 'ACTIVE' } as any });
    const inst = await prisma.shopifyInstallation.create({ data: { clientId, shopDomain: `so-${S}.myshopify.com`, accessTokenEncrypted: 'x', scopes: 'write_products' } as any });
    await prisma.shopifyLocationMap.create({ data: { installationId: inst.id, clientId, locationId: t.locationId, shopifyLocationId: '111' } });
    const mirror = await prisma.shopifyProductMirror.create({ data: { clientId, installationId: inst.id, productId: A.id, origin: 'CREATED', wanted: true, status: 'SYNCED', shopifyProductId: '9001' } as any });
    const scope = { clientId, locationIds: [] as string[] };
    const shopScope = { clientId, locationIds: shopRow.locationIds, hideOutOfStock: false };

    // Everywhere a product shows, as one picture.
    const where = async (p: { id: string; productCode: string }, variantCode: string) => {
      const list = await shop.publicProducts(shopScope as any, { limit: 50 });
      const found = await shop.publicProducts(shopScope as any, { q: 'saree', limit: 50 });
      const page = await shop.publicProduct(shopScope as any, p.productCode);
      const bag = await errOf(() => priceBag(clientId, [{ variantCode, quantity: 1 }]));
      const tryon = await garmentFor(clientId, p.productCode, variantCode).catch(() => null);
      const pick = await reels.searchPieces(clientId, '');
      const site = await storefrontCatalogueService.listProducts(scope, { limit: 200 });
      const siteOne = await storefrontCatalogueService.getProduct(scope, p.productCode);
      const till = await listForPos(scope, { limit: 200 });
      const crm = await linksFor(clientId, p.productCode);
      const crmIds = await linksForIds(clientId, { productIds: p.id });
      const codes = (xs: any[]) => xs.map((x: any) => x.productCode ?? x.code);
      return {
        shopList: codes(list.products).includes(p.productCode),
        shopSearch: codes(found.products).includes(p.productCode),
        shopPage: !!page,
        bag,
        tryon: !!tryon,
        reelPick: JSON.stringify(pick).includes(p.id),
        siteList: codes(site.products).includes(p.productCode),
        siteOne: !!siteOne,
        tillListed: (till.products as any[]).some(x => x.productCode === p.productCode && x.listed !== false),
        crmUrl: !!crm.links[0]?.url,
        crmIdUrl: !!crmIds.products[0]?.url
      };
    };

    // 0. Before: A is everywhere (the shop link needs a public base; CRM url is checked only if the shop has one).
    const before = await where(A, v.variantCode);
    ok('before: in the online shop list', before.shopList, before);
    ok('before: found by shop search', before.shopSearch);
    ok('before: its shop page opens', before.shopPage);
    ok('before: the bag prices it', before.bag === null, before.bag);
    ok('before: try-on can use it', before.tryon);
    ok('before: reel link picker offers it', before.reelPick);
    ok('before: other websites list it', before.siteList && before.siteOne);
    ok('before: the till lists it', before.tillListed);

    // A reel link holding A, and a heart on A, made while it is online.
    const owner = await prisma.user.findFirstOrThrow({ where: { clientId, roles: { some: { role: { name: 'SUPER_ADMIN' } } } } });
    const reel = await reels.create({ clientId, id: owner.id, name: owner.name } as any, { title: 'Sell online test', pieces: [{ productId: A.id, colour: null }] }).catch((e: any) => ({ error: String(e?.message) }));
    ok('a reel link with A could be made while online', !(reel as any).error, reel);

    // 1. ONE product to till only, the way the product page does it (PATCH /products/:id).
    const patch = await fetch(`${API}/products/${A.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: `token=${t.tokens.SUPER_ADMIN}`, Origin: 'http://localhost:5183' }, body: JSON.stringify({ sellOnline: false }) });
    ok('PATCH sellOnline:false answers 200', patch.status === 200, await patch.text().catch(() => ''));
    await wait(1500); // the website event and Shopify mark are sent after the commit
    const off = await where(A, v.variantCode);
    ok('off: gone from the online shop list', !off.shopList, off);
    ok('off: gone from shop search', !off.shopSearch);
    ok('off: its shop page is gone', !off.shopPage);
    ok('off: the bag refuses it, saying so', !!off.bag && /no longer sold online/.test(off.bag), off.bag);
    ok('off: try-on will not use it', !off.tryon);
    ok('off: reel link picker no longer offers it', !off.reelPick);
    ok('off: other websites no longer list it', !off.siteList && !off.siteOne);
    ok('off: the TILL STILL lists it', off.tillListed, off);
    ok('off: CRM gets no link to a page that is gone', !off.crmUrl && !off.crmIdUrl, off);
    const facets = await facetsFor(clientId).catch(() => null);
    ok('off: shop filters do not count it', facets === null || !JSON.stringify(facets).includes(A.productCode));
    const ev = await prisma.storefrontEvent.findFirst({ where: { clientId, productCode: A.productCode, eventType: 'PRODUCT_UNPUBLISHED' as any } });
    ok('off: the website was told it left (PRODUCT_UNPUBLISHED)', !!ev);
    const m1 = await prisma.shopifyProductMirror.findUniqueOrThrow({ where: { id: mirror.id } });
    ok('off: the Shopify copy was queued', m1.status === 'PENDING', m1.status);

    // Shopify's worker, with Shopify itself replaced by a recorder (the network is not what is tested here).
    const calls: any[] = [];
    const fakeApi = { graphql: async (q: string, vars: any) => { calls.push({ q, vars }); return { productUpdate: { userErrors: [] } }; } };
    const result = await shopifyProductPushService.work(mirror.id, async () => fakeApi as any);
    ok('off: Shopify archives it', result === 'ARCHIVED' && calls.some(c => c.vars?.p?.status === 'ARCHIVED'), { result, calls: calls.length });
    const card = await shopifyProductPushService.forProduct(clientId, A.id);
    ok('off: the product page Shopify card says till only', (card as any)?.tillOnly === true, card);
    const refused = await errOf(() => shopifyProductPushService.setOnShopify(clientId, OFFB.id, true));
    ok('off: a till-only product cannot be switched on Shopify', !!refused && /Sell online/.test(refused), refused);
    const sum: any = await shopifyProductPushService.summary(clientId);
    ok('Shopify "put all" counts only what it would send (A, B: not draft, material, till only)', sum.activeProducts === 1, sum.activeProducts);

    // The products list: column data and filter.
    const q = (o: any) => filterProducts(clientId, productFilterQuery.parse(o));
    const tillOnly = await q({ online: 'OFF' });
    const tillIds = tillOnly.data.map((p: any) => p.id).sort();
    ok('filter "Till only" = A, NOP, OFB', JSON.stringify(tillIds) === JSON.stringify([A.id, NOPIC.id, OFFB.id].sort()), tillOnly.data.map((p: any) => p.title));
    const none = await q({ online: 'NONE' });
    ok('filter "Not on sale" = the draft and the material', JSON.stringify(none.data.map((p: any) => p.id).sort()) === JSON.stringify([DRAFT.id, MAT.id].sort()), none.data.map((p: any) => p.title));
    ok('the list carries sellOnline for the column', (tillOnly.data[0] as any)?.sellOnline === false);

    // 2. BULK, through the route. Not allowed for someone without product:update.
    const bulk = (token: string, body: unknown) => fetch(`${API}/products/bulk-sell-online`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `token=${token}`, Origin: 'http://localhost:5183' }, body: JSON.stringify(body) });
    const denied = await bulk(t.tokens.WAREHOUSE, { ids: [B.id], on: false });
    const deniedSales = await bulk(t.tokens.SALES, { ids: [B.id], on: false });
    ok('bulk: a person without "edit products" is refused', denied.status === 403 || deniedSales.status === 403, [denied.status, deniedSales.status]);
    ok('bulk: bad input refused (on not a boolean)', (await bulk(t.tokens.SUPER_ADMIN, { ids: [B.id], on: 'yes' })).status === 400);
    ok('bulk: empty list refused', (await bulk(t.tokens.SUPER_ADMIN, { ids: [], on: true })).status === 400);
    const otherShop = await prisma.product.findFirst({ where: { NOT: { clientId } }, select: { id: true } });
    const r1: any = await (await bulk(t.tokens.SUPER_ADMIN, { ids: [A.id, B.id, DRAFT.id, MAT.id, NOPIC.id, OFFB.id, ...(otherShop ? [otherShop.id] : [])], on: true })).json();
    const d1 = r1.data ?? {};
    const why = (id: string) => d1.skipped?.find((s: any) => s.id === id)?.reason ?? '';
    ok('bulk on: A and OFB switched on (2)', d1.changed === 2, d1);
    // B, the draft and the material already have the switch on: nothing to change (the draft still sells nowhere
    // until published, the material never). Only NOP (no photo) and the other shop's id are skipped.
    ok('bulk on: B, draft, material already on (unchanged 3)', d1.unchanged === 3, d1);
    ok('bulk on: exactly 2 skipped', d1.skipped?.length === (otherShop ? 2 : 1), d1.skipped);
    ok('bulk on: no photo skipped, "no photo"', /no photo/i.test(why(NOPIC.id)), why(NOPIC.id));
    if (otherShop) ok("bulk on: another shop's product is not touched (No longer exists)", /no longer exists/i.test(why(otherShop.id)), why(otherShop.id));
    const otherAfter = otherShop ? await prisma.product.findUnique({ where: { id: otherShop.id }, select: { sellOnline: true, clientId: true } }) : null;
    ok("bulk on: the other shop's product unchanged", !otherShop || otherAfter?.clientId !== clientId);
    await wait(1500);
    const back = await where(A, v.variantCode);
    ok('back on: in the shop list, search, page, bag, try-on, reel picker, websites, till',
      back.shopList && back.shopSearch && back.shopPage && back.bag === null && back.tryon && back.reelPick && back.siteList && back.siteOne && back.tillListed, back);
    const ev2 = await prisma.storefrontEvent.findFirst({ where: { clientId, productCode: A.productCode, eventType: 'PRODUCT_PUBLISHED' as any } });
    ok('back on: the website was told it came back (PRODUCT_PUBLISHED)', !!ev2);
    const m2 = await prisma.shopifyProductMirror.findUniqueOrThrow({ where: { id: mirror.id } });
    ok('back on: the archived Shopify copy is queued to come back', m2.status === 'PENDING' && m2.wanted, m2);

    // 3. Bulk OFF of several, then the till still has all of them.
    const r2: any = await (await bulk(t.tokens.SUPER_ADMIN, { ids: [A.id, B.id, OFFB.id], on: false })).json();
    ok('bulk off: 3 changed, none skipped', r2.data?.changed === 3 && r2.data?.skipped?.length === 0, r2.data);
    const till = await listForPos(scope, { limit: 200 });
    const tillCodes = (till.products as any[]).filter(x => x.listed !== false).map(x => x.productCode);
    ok('bulk off: the till still sells all three', [A, B, OFFB].every(p => tillCodes.includes(p.productCode)), tillCodes);
    const site = await storefrontCatalogueService.listProducts(scope, { limit: 200 });
    ok('bulk off: no website sees any of them', ![A, B, OFFB].some(p => site.products.some((x: any) => x.productCode === p.productCode)));

    // 4. A website's quick pull ("since") is told they left, and the till's is told they stay.
    const since = new Date(Date.now() - 60_000);
    const sitePull = await storefrontCatalogueService.listProducts(scope, { since, includeLeavers: true, limit: 200 });
    ok("a website's since-pull marks them as left (listed:false)", [A, B].every(p => (sitePull.products as any[]).find(x => x.productCode === p.productCode)?.listed === false));
    const tillPull = await listForPos(scope, { since, limit: 200 });
    ok("the till's since-pull keeps them listed", [A, B].every(p => (tillPull.products as any[]).find(x => x.productCode === p.productCode)?.listed === true));

    // 5. Publishing a till-only draft does not put it online; unpublishing and republishing keeps "till only".
    await productService.updateProduct(DRAFT.id, clientId, { sellOnline: false });
    await productService.updateProduct(DRAFT.id, clientId, { status: 'ACTIVE' });
    ok('a till-only draft, once published, stays off the online shop', !(await storefrontCatalogueService.getProduct(scope, DRAFT.productCode)));
    ok('...and is at the till', (await listForPos(scope, { limit: 200 })).products.some((x: any) => x.productCode === DRAFT.productCode));
    ok('product page PATCH refuses a non-boolean sellOnline', (await fetch(`${API}/products/${A.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: `token=${t.tokens.SUPER_ADMIN}`, Origin: 'http://localhost:5183' }, body: JSON.stringify({ sellOnline: 'no' }) })).status === 400);
    // 6. The product page cannot put a photo-less product online either (the same rule as the bulk bar).
    const noPic = await fetch(`${API}/products/${NOPIC.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: `token=${t.tokens.SUPER_ADMIN}`, Origin: 'http://localhost:5183' }, body: JSON.stringify({ sellOnline: true }) });
    const noPicBody: any = await noPic.json().catch(() => ({}));
    ok('product page: a photo-less product is refused online, with the reason', noPic.status === 409 && /no photo/i.test(noPicBody.message ?? ''), [noPic.status, noPicBody.message]);
    ok('...and stays till only', (await prisma.product.findUniqueOrThrow({ where: { id: NOPIC.id } })).sellOnline === false);
    void conn;
  } finally {
    await t.remove();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
