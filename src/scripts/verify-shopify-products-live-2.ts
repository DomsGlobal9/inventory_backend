// NEVER RUN BLIND: creates and archives products in a REAL Shopify test store (mc1qbm-i4).
// Needs the LOCAL db with that store's installation copied in (fresh key: under an hour old).
// LIVE round 2 against the trial store, LOCAL db. The installation is lent to a tiny fresh tenant for
// "Put all", then given back to verify-suites-tenant.
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { adminApiFor, ShopifyApiError } from '../services/shopify-mapping';
import { shopifyProductPushService as push, markProductForShopify } from '../services/shopify-products';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { variantService } from '../services/variant.service';

if (!String(process.env.DATABASE_URL).includes('localhost:55433')) throw new Error('LOCAL db only');
const SHOP = 'mc1qbm-i4.myshopify.com';
const HOME = 'verify-suites-tenant';
const S = Date.now() % 1_000_000;
const TINY = `shopify-tiny-${S}`;
let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d: unknown = '') => { if (ok) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} -- ${JSON.stringify(d).slice(0, 400)}`); } };

(async () => {
  const inst = await prisma.shopifyInstallation.findUniqueOrThrow({ where: { shopDomain: SHOP } });
  const api = await adminApiFor(inst.id, inst.shopDomain);
  const apiFor = async () => api;
  const drain = async (max = 8) => { for (let i = 0; i < max; i++) { const r = await push.runOnce(apiFor); if (r.length === 0) return; } };
  const read = async (id: string) => (await api.graphql(`query($id: ID!) { product(id: $id) { id title status descriptionHtml variants(first: 20) { nodes { id sku price } } } }`, { id: `gid://shopify/Product/${id}` }) as any).product;
  const homeMain = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: HOME, name: 'Main Store' } });
  const pairing = await prisma.shopifyLocationMap.findFirstOrThrow({ where: { installationId: inst.id } });

  try {
    console.log('\n1. "PUT ALL PRODUCTS ON SHOPIFY" ON A SMALL SHOP');
    const loc = await prisma.stockLocation.create({ data: { clientId: TINY, name: 'Main Store', code: `T${S}`, type: 'STORE' as any } as any });
    await prisma.shopifyInstallation.update({ where: { id: inst.id }, data: { clientId: TINY } });
    await prisma.shopifyLocationMap.update({ where: { id: pairing.id }, data: { clientId: TINY, locationId: loc.id } });
    const made: string[] = [];
    for (const [i, kind] of [[1, 'active'], [2, 'active'], [3, 'draft'], [4, 'service'], [5, 'trashed']] as const) {
      const p = await prisma.product.create({ data: { clientId: TINY, productCode: `TINY-${S}-${i}`, slug: `tiny-${S}-${i}`, title: `Tiny ${kind} ${S}-${i}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 999,
        status: (kind === 'draft' ? 'DRAFT' : 'ACTIVE') as any, isService: kind === 'service', trashedAt: kind === 'trashed' ? new Date() : null } });
      const v = await prisma.productVariant.create({ data: { productId: p.id, clientId: TINY, variantCode: `TINYV-${S}-${i}`, sku: `TINY-${S}-${i}`, sellingPrice: 999, colorName: 'Teal', size: 'Free Size' } });
      await inventoryMutationService.applyMovement({ clientId: TINY, variantId: v.id, locationId: loc.id, movementType: 'IN', reason: 'PURCHASE', quantityDelta: 2, unitCost: 400, notes: 'tiny', createdBy: 'tiny' } as any);
      made.push(p.id);
    }
    const r1 = await push.putAll(TINY);
    check('only the two active, non-service products are added', r1.added === 2, r1);
    const r2 = await push.putAll(TINY);
    check('pressed twice: nothing added the second time', r2.added === 0 && r2.switchedOn === 0, r2);
    await drain();
    const mirrors = await prisma.shopifyProductMirror.findMany({ where: { clientId: TINY } });
    check('both are in Shopify and up to date', mirrors.length === 2 && mirrors.every(m => m.status === 'SYNCED' && m.shopifyProductId), mirrors.map(m => [m.status, m.problem]));
    const sum = await push.summary(TINY);
    check('the card counts 2 on Shopify, 2 up to date, 0 more to add', sum?.onShopify === 2 && sum?.upToDate === 2 && sum.activeProducts - sum.onShopify === 0, sum);
    const homeRow = await prisma.shopifyProductMirror.findFirst({ where: { clientId: HOME, wanted: true, status: 'SYNCED', origin: 'CREATED' } });
    if (homeRow) {
      await markProductForShopify(homeRow.productId); await drain();
      const after = await prisma.shopifyProductMirror.findUniqueOrThrow({ where: { id: homeRow.id } });
      check('the previous workspace\'s product is NOT sent into a store it no longer owns', after.status === 'FAILED' && /another workspace/.test(after.problem ?? ''), after);
    }
    for (const m of mirrors) await push.setOnShopify(TINY, m.productId, false);
    await drain();
    const archived = await Promise.all(mirrors.map(m => read(m.shopifyProductId!)));
    check('switched off afterwards: both archived', archived.every(p => p.status === 'ARCHIVED'), archived.map(p => p.status));
  } finally {
    await prisma.shopifyInstallation.update({ where: { id: inst.id }, data: { clientId: HOME } });
    await prisma.shopifyLocationMap.update({ where: { id: pairing.id }, data: { clientId: HOME, locationId: homeMain.id } });
  }

  await push.retryFailed(HOME); await drain();
  console.log('\n2. A PRODUCT FOR THE REST');
  const p = await prisma.product.create({ data: { clientId: HOME, productCode: `SP2-${S}`, slug: `sp2-${S}`, title: `Round two saree ${S}`, description: 'First words.', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1800, status: 'ACTIVE' as any } });
  const v = await prisma.productVariant.create({ data: { productId: p.id, clientId: HOME, variantCode: `SP2V-${S}`, sku: `SP2-${S}-A`, sellingPrice: 1800, colorName: 'Gold', size: 'Free Size' } });
  await inventoryMutationService.applyMovement({ clientId: HOME, variantId: v.id, locationId: homeMain.id, movementType: 'IN', reason: 'PURCHASE', quantityDelta: 3, unitCost: 700, notes: 'r2', createdBy: 'r2' } as any);
  await push.setOnShopify(HOME, p.id, true); await drain();
  let m = await prisma.shopifyProductMirror.findFirstOrThrow({ where: { productId: p.id } });
  check('(set-up) on Shopify', m.status === 'SYNCED', m);
  const sid = m.shopifyProductId!;
  const webhookOf = (sp: any, over: any = {}) => ({ id: Number(sid), title: sp.title, body_html: sp.descriptionHtml, status: sp.status.toLowerCase(), variants: sp.variants.nodes.map((x: any) => ({ sku: x.sku, price: x.price, compare_at_price: null })), ...over });

  console.log('\n3. ITEM CODE RENAMED HERE');
  await variantService.updateVariant(v.id, HOME, { sku: `SP2-${S}-RENAMED` }); await drain();
  let sp = await read(sid);
  check('Shopify shows the new code on the SAME variant', sp.variants.nodes.length === 1 && sp.variants.nodes[0].sku === `SP2-${S}-RENAMED`, sp.variants.nodes);

  console.log('\n4. EDITS MADE INSIDE SHOPIFY');
  await api.graphql(`mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { userErrors { message } } }`, { p: { id: `gid://shopify/Product/${sid}`, descriptionHtml: '<p>Somebody else wrote this.</p>' } });
  sp = await read(sid);
  check('a description changed in Shopify is noticed', await push.onProductUpdated(SHOP, webhookOf(sp)) === 'APPLIED');
  const dn = await prisma.inventoryAlert.findFirst({ where: { clientId: HOME, title: `Changed in Shopify: Round two saree ${S}` }, orderBy: { createdAt: 'desc' } });
  check('...the notice says "the description"', /the description/.test(dn?.message ?? ''), dn?.message);
  await drain(); sp = await read(sid);
  check('...and our words are back', /First words\./.test(sp.descriptionHtml), sp.descriptionHtml);
  await api.graphql(`mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { userErrors { message } } }`, { p: { id: `gid://shopify/Product/${sid}`, status: 'DRAFT' } });
  sp = await read(sid);
  check('set to draft in Shopify: noticed', await push.onProductUpdated(SHOP, webhookOf(sp)) === 'APPLIED');
  await drain(); sp = await read(sid);
  check('...and it is active again', sp.status === 'ACTIVE', sp.status);

  console.log('\n5. DELETED INSIDE SHOPIFY');
  // The message only: nothing in the shop's store is deleted by a test.
  check('noticed', await push.onProductDeleted(SHOP, { id: Number(sid) }) === 'APPLIED');
  const del = await prisma.inventoryAlert.findFirst({ where: { clientId: HOME, title: `Deleted in Shopify: Round two saree ${S}` } });
  check('...the notice explains it is being put back, and how to stop that', /putting it back/.test(del?.message ?? '') && /switch off/.test(del?.message ?? ''), del?.message);
  await drain();
  m = await prisma.shopifyProductMirror.findFirstOrThrow({ where: { productId: p.id } });
  const again = m.shopifyProductId ? await read(m.shopifyProductId) : null;
  check('...it is in Shopify again and active (found by its tag, no second copy)', m.status === 'SYNCED' && !!again && again.status === 'ACTIVE', [m.status, m.problem, again?.id]);
  check('...its variant is remembered under the new id', !!(await prisma.shopifyIdMap.findFirst({ where: { variantId: v.id, shopifyProductId: m.shopifyProductId! } })));

  console.log('\n6. NO LOCATION PAIRED');
  const pair = await prisma.shopifyLocationMap.findFirstOrThrow({ where: { installationId: inst.id } });
  await prisma.shopifyLocationMap.delete({ where: { id: pair.id } });
  try {
    await markProductForShopify(p.id); await drain(2);
    m = await prisma.shopifyProductMirror.findFirstOrThrow({ where: { productId: p.id } });
    check('refused in words that say what to do', m.status === 'FAILED' && /Pair a Shopify location/.test(m.problem ?? ''), m);
  } finally {
    await prisma.shopifyLocationMap.create({ data: { installationId: inst.id, clientId: HOME, locationId: pair.locationId, shopifyLocationId: pair.shopifyLocationId } });
  }
  const retried = await push.retryFailed(HOME);
  await drain();
  m = await prisma.shopifyProductMirror.findFirstOrThrow({ where: { productId: p.id } });
  check('paired again + "Try again": it goes through', retried.retried >= 1 && m.status === 'SYNCED', m);

  console.log('\n7. SHOPIFY UNREACHABLE');
  await markProductForShopify(p.id);
  const down = async () => ({ graphql: async () => { throw new ShopifyApiError(`Could not reach ${SHOP}. Try again in a moment.`, 504); } }) as any;
  const res = await push.runOnce(down);
  m = await prisma.shopifyProductMirror.findFirstOrThrow({ where: { productId: p.id } });
  check('kept for later with a retry time, not given up', res.includes('RETRY') || (m.status === 'PENDING' && m.attempts === 1 && !!m.nextAttemptAt), [res, m.status, m.attempts]);
  await prisma.shopifyProductMirror.update({ where: { id: m.id }, data: { nextAttemptAt: null } });
  await drain();
  m = await prisma.shopifyProductMirror.findFirstOrThrow({ where: { productId: p.id } });
  check('...and catches up when Shopify is back', m.status === 'SYNCED' && m.attempts === 0, m);

  console.log('\n8. TWO WORKERS AT ONCE');
  await markProductForShopify(p.id);
  const [a, b] = await Promise.all([push.runOnce(apiFor), push.runOnce(apiFor)]);
  const worked = [...a, ...b].filter(x => x === 'SYNCED').length;
  check('the product is pushed by exactly one of them', worked === 1, [a, b]);
  const tagged: any = await api.graphql(`query($q: String!) { products(first: 5, query: $q) { nodes { id } } }`, { q: `tag:'scaleezy-sp2-${S}'` });
  check('...and Shopify still has exactly one copy', tagged.products.nodes.length === 1, tagged.products.nodes);

  await push.setOnShopify(HOME, p.id, false); await drain();
  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error('CRASHED', e); await prisma.$disconnect(); process.exit(1); });
