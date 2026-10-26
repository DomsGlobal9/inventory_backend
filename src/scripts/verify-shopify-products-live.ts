// NEVER RUN BLIND: creates and archives products in a REAL Shopify test store (mc1qbm-i4).
// Needs the LOCAL db with that store's installation copied in (fresh key: under an hour old).
// LIVE test of the Shopify product push against the trial store mc1qbm-i4, from the LOCAL db.
// Run with DATABASE_URL pointing at localhost:55433. Creates test products tagged scaleezy-spt-*;
// archives them at the end (never deletes).
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { adminApiFor, shopifyVariantMatchingService } from '../services/shopify-mapping';
import { shopifyProductPushService as push, markProductForShopify } from '../services/shopify-products';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { variantService } from '../services/variant.service';

if (!String(process.env.DATABASE_URL).includes('localhost:55433')) throw new Error('LOCAL db only');
const T = 'verify-suites-tenant';
const SHOP = 'mc1qbm-i4.myshopify.com';
const LOC = 'gid://shopify/Location/116745568565';
const STAMP = Date.now() % 1_000_000;
let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d: unknown = '') => { if (ok) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} -- ${JSON.stringify(d).slice(0, 400)}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const PRODUCT_Q = `query P($id: ID!, $loc: ID!, $pub: ID!) { product(id: $id) {
  id title descriptionHtml status tags vendor productType publishedOnPublication(publicationId: $pub)
  options { name values } media(first: 30) { nodes { id } }
  variants(first: 50) { nodes { id sku price compareAtPrice inventoryItem { id tracked inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } } } } } } }`;

(async () => {
  const inst = await prisma.shopifyInstallation.findUniqueOrThrow({ where: { shopDomain: SHOP } });
  const api = await adminApiFor(inst.id, inst.shopDomain);
  const apiFor = async () => api;
  const pubs: any = await api.graphql(`{ publications(first: 20) { nodes { id name } } }`);
  const PUB = pubs.publications.nodes.find((n: any) => n.name === 'Online Store').id;
  const main = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: T, name: 'Main Store' } });

  // A photo that is really public: one of sphl's, read from the shared db.
  const envText = fs.readFileSync('D:/villy/inventory/backend/.env', 'utf8');
  const shared = new PrismaClient({ datasources: { db: { url: (envText.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m) || [])[1] } } });
  const photo = (await shared.productImage.findFirst({ where: { url: { startsWith: 'https://' }, product: { clientId: 'sphl' } }, select: { url: true } }))!.url;
  await shared.$disconnect();

  const drain = async (max = 6) => { for (let i = 0; i < max; i++) { const r = await push.runOnce(apiFor); if (r.length === 0) return; } };
  const mirrorOf = (productId: string) => prisma.shopifyProductMirror.findFirstOrThrow({ where: { productId } });
  const read = async (shopifyProductId: string) => (await api.graphql(PRODUCT_Q, { id: `gid://shopify/Product/${shopifyProductId}`, loc: LOC, pub: PUB }) as any).product;
  const qty = (v: any) => v?.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity;
  const stockIn = (variantId: string, delta: number) => inventoryMutationService.applyMovement({
    clientId: T, variantId, locationId: main.id, movementType: delta > 0 ? 'IN' : 'OUT', reason: delta > 0 ? 'PURCHASE' : 'SALE',
    quantityDelta: delta, unitCost: 500, notes: 'shopify live push test', createdBy: 'shopify-live-push'
  } as any);

  console.log('\n1. A NEW PRODUCT GOES ON SHOPIFY');
  const product = await prisma.product.create({ data: {
    clientId: T, productCode: `SPT-${STAMP}`, slug: `spt-${STAMP}`, title: `Push test saree ${STAMP}`,
    description: 'Pure silk & zari border.\nHand woven <Kanchi> style.\n\nDry clean only.',
    category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', brand: 'Swathi',
    basePrice: 1500, status: 'ACTIVE' as any, publishedAt: new Date()
  } });
  const mk = (color: string, size: string, price: number) => prisma.productVariant.create({ data: {
    productId: product.id, clientId: T, colorName: color, size, sellingPrice: price,
    variantCode: `SPTV-${STAMP}-${color}-${size}`, sku: `SPT-${STAMP}-${color}-${size}`.toUpperCase()
  } });
  const redM = await mk('Red', 'M', 1500), redL = await mk('Red', 'L', 1600), blueM = await mk('Blue', 'M', 1500);
  await stockIn(redM.id, 5); await stockIn(redL.id, 3);
  await prisma.productImage.create({ data: { productId: product.id, url: photo, imageType: 'COVER' as any, isPrimary: true } });

  await push.setOnShopify(T, product.id, true);
  await drain();
  let m = await mirrorOf(product.id);
  check('the push finished', m.status === 'SYNCED', { status: m.status, problem: m.problem });
  let sp = m.shopifyProductId ? await read(m.shopifyProductId) : null;
  check('Shopify has it with our title, active', sp?.title === product.title && sp?.status === 'ACTIVE', sp && { t: sp.title, s: sp.status });
  check('...visible in the Online Store', sp?.publishedOnPublication === true, sp?.publishedOnPublication);
  check('...description kept its words, < and & safely', /Pure silk &amp; zari border/.test(sp?.descriptionHtml ?? '') && /&lt;Kanchi&gt;/.test(sp?.descriptionHtml ?? ''), sp?.descriptionHtml);
  check('...options Colour and Size', JSON.stringify(sp?.options?.map((o: any) => o.name)) === '["Colour","Size"]', sp?.options);
  const byS = (s: string) => sp?.variants?.nodes?.find((v: any) => v.sku === s);
  check('...three variants, prices right', sp?.variants?.nodes?.length === 3 && byS(redL.sku)?.price === '1600.00' && byS(redM.sku)?.price === '1500.00', sp?.variants?.nodes);
  check('...stock right at the paired location: 5, 3, 0', qty(byS(redM.sku)) === 5 && qty(byS(redL.sku)) === 3 && qty(byS(blueM.sku)) === 0, sp?.variants?.nodes?.map((v: any) => [v.sku, qty(v)]));
  check('...tracked, so Shopify will not oversell', sp?.variants?.nodes?.every((v: any) => v.inventoryItem.tracked), '');
  check('...the photo is there', (sp?.media?.nodes?.length ?? 0) === 1, sp?.media);
  check('...vendor and type from brand and dress type', sp?.vendor === 'Swathi' && sp?.productType === 'Saree', [sp?.vendor, sp?.productType]);
  const maps = await prisma.shopifyIdMap.count({ where: { installationId: inst.id, variantId: { in: [redM.id, redL.id, blueM.id] }, origin: 'CREATED' } });
  check('...all three variants remembered, so Shopify orders find them', maps === 3, maps);
  const firstId = m.shopifyProductId;

  console.log('\n2. A PRICE CHANGED HERE FOLLOWS');
  await variantService.updateVariant(redM.id, T, { sellingPrice: 1450 });
  m = await mirrorOf(product.id);
  check('the edit queued the product', m.status === 'PENDING', m.status);
  await drain();
  sp = await read(firstId!);
  check('Shopify shows 1450 for Red M', sp.variants.nodes.find((v: any) => v.sku === redM.sku)?.price === '1450.00', sp.variants.nodes);
  check('...and the variant kept its Shopify id (not re-made)', sp.variants.nodes.length === 3 && (await prisma.shopifyIdMap.findFirst({ where: { variantId: redM.id } }))?.shopifyVariantId === sp.variants.nodes.find((v: any) => v.sku === redM.sku).id.split('/').pop(), '');

  console.log('\n3. A SALE HERE MOVES SHOPIFY STOCK');
  await stockIn(redM.id, -2);
  await sleep(300);
  m = await mirrorOf(product.id);
  check('the sale queued a stock update', m.stockPending === true, m);
  await drain();
  sp = await read(firstId!);
  check('Shopify shows 3 for Red M', qty(sp.variants.nodes.find((v: any) => v.sku === redM.sku)) === 3, sp.variants.nodes.map((v: any) => [v.sku, qty(v)]));

  console.log('\n4. SHOPIFY TELLING US ABOUT OUR OWN PUSH');
  const asWebhook = (p: any) => ({ id: Number(p.id.split('/').pop()), title: p.title, body_html: p.descriptionHtml, status: p.status.toLowerCase(),
    variants: p.variants.nodes.map((v: any) => ({ sku: v.sku, price: v.price, compare_at_price: v.compareAtPrice })) });
  check('our own product update comes back as an echo', await push.onProductUpdated(SHOP, asWebhook(sp)) === 'ECHO');
  const redMItem = sp.variants.nodes.find((v: any) => v.sku === redM.sku).inventoryItem.id.split('/').pop();
  check('our own stock write comes back as an echo', await push.onInventoryChanged(SHOP, { inventory_item_id: Number(redMItem), location_id: 116745568565, available: 3 }) === 'ECHO');

  console.log('\n5. SOMEONE CHANGES THE PRICE INSIDE SHOPIFY');
  const alertsBefore = await prisma.inventoryAlert.count({ where: { clientId: T, title: { startsWith: 'Changed in Shopify' } } });
  const redMVar = sp.variants.nodes.find((v: any) => v.sku === redM.sku).id;
  const edit: any = await api.graphql(`mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $p, variants: $v) { userErrors { message } } }`, { p: sp.id, v: [{ id: redMVar, price: '999.00' }] });
  check('(set-up) the price was changed in Shopify', !edit.productVariantsBulkUpdate.userErrors.length, edit);
  const edited = await read(firstId!);
  check('ScaleEzy notices it is not its own', await push.onProductUpdated(SHOP, asWebhook(edited)) === 'APPLIED');
  const notice = await prisma.inventoryAlert.findFirst({ where: { clientId: T, title: { startsWith: 'Changed in Shopify' } }, orderBy: { createdAt: 'desc' } });
  check('...a bell notice says what changed', (await prisma.inventoryAlert.count({ where: { clientId: T, title: { startsWith: 'Changed in Shopify' } } })) === alertsBefore + 1 && /1450\.00 to ₹999\.00/.test(notice?.message ?? ''), notice?.message);
  await drain();
  sp = await read(firstId!);
  check('...and ScaleEzy put 1450 back', sp.variants.nodes.find((v: any) => v.sku === redM.sku)?.price === '1450.00', sp.variants.nodes.map((v: any) => [v.sku, v.price]));
  check('a stock number typed in Shopify is re-sent a little later (not at once)', await push.onInventoryChanged(SHOP, { inventory_item_id: Number(redMItem), location_id: 116745568565, available: 9 }) === 'APPLIED'
    && (await mirrorOf(product.id)).nextAttemptAt! > new Date(Date.now() + 60_000), await mirrorOf(product.id));
  await prisma.shopifyProductMirror.update({ where: { id: m.id }, data: { nextAttemptAt: null } });
  await drain();

  console.log('\n6. SWITCHED OFF, THEN ON AGAIN');
  await push.setOnShopify(T, product.id, false);
  await drain();
  sp = await read(firstId!);
  check('switched off: archived in Shopify, not deleted', sp?.status === 'ARCHIVED', sp?.status);
  await push.setOnShopify(T, product.id, true);
  await drain();
  sp = await read(firstId!);
  check('switched on again: the SAME product is active again', sp?.status === 'ACTIVE' && (await mirrorOf(product.id)).shopifyProductId === firstId, sp?.status);

  console.log('\n7. A PUSH THAT LOST ITS ANSWER (timeout after Shopify made it)');
  await prisma.shopifyProductMirror.update({ where: { id: m.id }, data: { shopifyProductId: null, status: 'PENDING' } });
  await drain();
  m = await mirrorOf(product.id);
  const tagged: any = await api.graphql(`query($q: String!) { products(first: 5, query: $q) { nodes { id } } }`, { q: `tag:'scaleezy-spt-${STAMP}'` });
  check('found by its tag: still ONE product in Shopify, the same one', m.shopifyProductId === firstId && tagged.products.nodes.length === 1, { id: m.shopifyProductId, firstId, n: tagged.products.nodes.length });

  console.log('\n8. A NEW SIZE, AND A SIZE DELETED HERE');
  const redS = await mk('Red', 'S', 1400);
  await markProductForShopify(product.id); await drain();
  await variantService.deleteVariant(blueM.id, T).catch(() => prisma.productVariant.delete({ where: { id: blueM.id } }));
  await markProductForShopify(product.id); await drain();
  sp = await read(firstId!);
  const skus = sp.variants.nodes.map((v: any) => v.sku).sort();
  check('Shopify has Red S, L, M and no Blue M', JSON.stringify(skus) === JSON.stringify([redL.sku, redM.sku, redS.sku].sort()), skus);
  check('...Red M kept its stock of 3 through it', qty(sp.variants.nodes.find((v: any) => v.sku === redM.sku)) === 3, sp.variants.nodes.map((v: any) => [v.sku, qty(v)]));

  console.log('\n9. REFUSED IN WORDS: a product with no price');
  const noPrice = await prisma.product.create({ data: { clientId: T, productCode: `SPN-${STAMP}`, slug: `spn-${STAMP}`, title: `No price ${STAMP}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 0, status: 'ACTIVE' as any } });
  await prisma.productVariant.create({ data: { productId: noPrice.id, clientId: T, colorName: 'Red', size: 'M', variantCode: `SPNV-${STAMP}`, sku: `SPN-${STAMP}`, sellingPrice: 0 } });
  await push.setOnShopify(T, noPrice.id, true); await drain();
  const np = await mirrorOf(noPrice.id);
  check('it fails with a sentence, and is not retried for ever', np.status === 'FAILED' && /no selling price/.test(np.problem ?? ''), np);

  console.log('\n10. A PRODUCT THE SHOP BUILT BY HAND IN SHOPIFY, MATCHED BY ITEM CODE');
  const hmSku = `HM-${STAMP}`;
  const made: any = await api.graphql(`mutation($i: ProductSetInput!) { productSet(input: $i, synchronous: true) { product { id } userErrors { message } } }`,
    { i: { title: `Hand-made in Shopify ${STAMP}`, status: 'ACTIVE', productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants: [{ optionValues: [{ optionName: 'Title', name: 'Default Title' }], price: '800.00', inventoryItem: { sku: hmSku, tracked: true } }] } });
  const hmGid = made.productSet.product?.id;
  check('(set-up) a hand-made product exists in Shopify', !!hmGid, made);
  const ours = await prisma.product.create({ data: { clientId: T, productCode: `SPH-${STAMP}`, slug: `sph-${STAMP}`, title: `Our name for it ${STAMP}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 750, status: 'ACTIVE' as any } });
  const ourV = await prisma.productVariant.create({ data: { productId: ours.id, clientId: T, variantCode: `SPHV-${STAMP}`, sku: hmSku, sellingPrice: 750 } });
  await stockIn(ourV.id, 4);
  const matched = await shopifyVariantMatchingService.matchBySku(T, api);
  await push.ensureMatchedMirrors(T, inst.id);
  check('(set-up) matched by item code', matched.newlyMatched >= 1, matched);
  await drain();
  const hm = await read(hmGid.split('/').pop());
  check('its price and stock follow ours: 750, 4', hm.variants.nodes[0].price === '750.00' && qty(hm.variants.nodes[0]) === 4, hm.variants.nodes);
  check('...its title is left as the shop wrote it', hm.title === `Hand-made in Shopify ${STAMP}`, hm.title);
  const sw = await push.setOnShopify(T, ours.id, true);
  check('"On Shopify" on it does not make a second copy', sw?.origin === 'MATCHED', sw);
  await prisma.product.update({ where: { id: ours.id }, data: { trashedAt: new Date() } });
  await markProductForShopify(ours.id); await drain();
  const hm2 = await read(hmGid.split('/').pop());
  check('deleted here: never archived in Shopify, but its stock goes to 0', hm2.status === 'ACTIVE' && qty(hm2.variants.nodes[0]) === 0, [hm2.status, qty(hm2.variants.nodes[0])]);

  console.log('\n11. DELETED HERE -> ARCHIVED THERE');
  await prisma.product.update({ where: { id: product.id }, data: { trashedAt: new Date() } });
  await markProductForShopify(product.id); await drain();
  sp = await read(firstId!);
  check('a product of ours in the bin is archived in Shopify', sp?.status === 'ARCHIVED', sp?.status);

  console.log(`\nShopify ids: test product ${firstId}, hand-made ${hmGid}`);
  console.log(`RESULT: ${passed} passed | ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error('CRASHED', e); await prisma.$disconnect(); process.exit(1); });
