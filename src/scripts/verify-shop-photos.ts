/**
 * Which photographs a shopper sees, and how many.
 *
 * Two bugs live here, both found on a real shop by an owner counting pictures in the admin and
 * counting fewer in their shop:
 *
 *   two colours, one file   Every product that existed before photographs belonged to colours had
 *                           its pictures COPIED onto each variant. So both colours of a saree
 *                           point at the same five files. The catalogue collapsed duplicates by
 *                           url alone, which folded the two colours into one -- five rows out of
 *                           ten survived, each keeping whichever colour sorted first, and the
 *                           shop showed two pictures for one colour and three for the other out
 *                           of five that both of them have.
 *
 *   hidden, but shown       RAW_UPLOAD is how a merchant says "not in my shop". A shop setting
 *                           called "Show every photo" outranked it, so twenty-two deliberately
 *                           hidden pictures were live, and pressing hide again did nothing.
 *
 * Builds its own product in the shape the migration left behind, and deletes it again.
 *
 *   npx ts-node src/scripts/verify-shop-photos.ts
 */
import { prisma } from '../lib/prisma';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';
import * as onlineShop from '../services/online-shop/shop.service';

const SHOP = (process.env.PHOTO_JOBS_ONLY_CLIENTS || '').split(',')[0].trim() || 'verify-suites-tenant';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const made = new Set<string>();
let stamp = Date.now();

async function buildProduct(title: string) {
  stamp++;
  const p = await prisma.product.create({
    data: {
      clientId: SHOP, productCode: `VERIFY-PH-${stamp}`, slug: `verify-ph-${stamp}`,
      title, category: 'WOMEN', productType: 'READY_TO_WEAR', dressType: 'Saree',
      basePrice: 1000, status: 'ACTIVE', publishedAt: new Date()
    }
  });
  made.add(p.id);
  return p;
}

let n = 0;
async function addVariant(productId: string, colour: string, size: string) {
  n++;
  return prisma.productVariant.create({
    data: {
      productId, clientId: SHOP, colorName: colour, size,
      variantCode: `VPH${n}-${stamp}`, sku: `VPH-${stamp}-${n}`, sellingPrice: 1000
    }
  });
}

const addImage = (productId: string, variantId: string | null, url: string, extra: any = {}) =>
  prisma.productImage.create({
    data: { productId, variantId, url, imageType: 'GALLERY', orderIndex: 0, ...extra }
  });

async function seen(code: string) {
  const scope = {
    clientId: SHOP,
    locationIds: (await prisma.stockLocation.findMany({ where: { clientId: SHOP }, select: { id: true } })).map(l => l.id),
    allPhotos: false
  };
  const p = await storefrontCatalogueService.getProduct(scope, code);
  return p?.images ?? [];
}

async function main() {
  console.log(`WHAT A SHOPPER SEES  (shop: ${SHOP})\n`);

  // ── The shape the migration left behind ─────────────────────────────────────────────────────
  console.log('TWO COLOURS THAT SHARE THE SAME PICTURE FILES');

  const migrated = await buildProduct('Verify shop photos, migrated (delete me)');
  const maroon = await addVariant(migrated.id, 'Maroon', 'Free Size');
  const teal = await addVariant(migrated.id, 'Teal', 'Free Size');

  // One file per view, copied onto BOTH colours -- exactly what 20260924190000 did.
  const files = [
    { url: 'https://example.invalid/front.jpg', generated: true, view: 'front', isPrimary: true, orderIndex: 0 },
    { url: 'https://example.invalid/left.jpg', generated: true, view: 'left', orderIndex: 1 },
    { url: 'https://example.invalid/right.jpg', generated: true, view: 'right', orderIndex: 2 },
    { url: 'https://example.invalid/back.jpg', generated: true, view: 'back', orderIndex: 3 },
    { url: 'https://example.invalid/own.jpg', generated: false, orderIndex: 4 }
  ];
  for (const f of files) {
    const { url, ...rest } = f;
    await addImage(migrated.id, maroon.id, url, rest);
    await addImage(migrated.id, teal.id, url, rest);
  }

  const shown = await seen(migrated.productCode);
  const forMaroon = shown.filter(i => i.variantCode === maroon.variantCode);
  const forTeal = shown.filter(i => i.variantCode === teal.variantCode);

  check('both colours keep all five of their photographs',
    forMaroon.length === 5 && forTeal.length === 5,
    `Maroon ${forMaroon.length}, Teal ${forTeal.length} (of 5 each) -- this is the bug the shop owner reported`);
  check('  ...and nothing is invented: ten rows, ten entries', shown.length === 10, String(shown.length));
  check('  ...each colour seeing every distinct file once',
    new Set(forMaroon.map(i => i.url)).size === 5 && new Set(forTeal.map(i => i.url)).size === 5);

  // ── Sizes of one colour are still one photograph ────────────────────────────────────────────
  console.log('\nSIZES OF ONE COLOUR ARE ONE PHOTOGRAPH');

  const sized = await buildProduct('Verify shop photos, sizes (delete me)');
  const redS = await addVariant(sized.id, 'Red', 'S');
  const redM = await addVariant(sized.id, 'Red', 'M');
  const redL = await addVariant(sized.id, 'Red', 'L');
  for (const v of [redS, redM, redL]) {
    await addImage(sized.id, v.id, 'https://example.invalid/red-one.jpg', { isPrimary: true });
  }

  const sizedShown = await seen(sized.productCode);
  check('one photograph on three sizes of one colour is shown ONCE',
    sizedShown.length === 1, `${sizedShown.length} entries -- three of the same picture is a gallery of duplicates`);

  // ── Hidden means hidden ─────────────────────────────────────────────────────────────────────
  console.log('\nA PICTURE THE SHOP HID');

  const hiding = await buildProduct('Verify shop photos, hidden (delete me)');
  const blue = await addVariant(hiding.id, 'Blue', 'Free Size');
  await addImage(hiding.id, blue.id, 'https://example.invalid/in-shop.jpg', { isPrimary: true });
  await addImage(hiding.id, blue.id, 'https://example.invalid/flat-lay.jpg', { imageType: 'RAW_UPLOAD' });

  const hidingShown = await seen(hiding.productCode);
  check('a RAW_UPLOAD picture never reaches a customer',
    hidingShown.length === 1 && !hidingShown.some(i => i.url.includes('flat-lay')),
    JSON.stringify(hidingShown.map(i => i.url)));

  // And through the shop's own front door, which is where the setting used to override it.
  const shopRow = await prisma.onlineShop.findFirst({ where: { clientId: SHOP }, select: { showAllPhotos: true, locationIds: true, hideOutOfStock: true } });
  if (shopRow) {
    const viaShop = await onlineShop.publicProduct(
      { clientId: SHOP, locationIds: shopRow.locationIds, allPhotos: true, showFewLeft: false },
      hiding.productCode
    );
    check('  ...even when the shop asks for every photo',
      (viaShop?.images ?? []).every((i: any) => !String(i.url).includes('flat-lay')),
      'the "Show every photo" setting used to outrank the hide button; 22 hidden pictures were live');
  }

  // ── The order they are met in ───────────────────────────────────────────────────────────────
  console.log('\nTHE ORDER A SHOPPER MEETS THEM IN');

  const order = shown.filter(i => i.variantCode === maroon.variantCode).map(i => i.url.split('/').pop());
  check('the starred one leads, then front, sitting, side, back, then the shop\'s own',
    JSON.stringify(order) === JSON.stringify(['front.jpg', 'left.jpg', 'right.jpg', 'back.jpg', 'own.jpg']),
    JSON.stringify(order));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`failed: ${failures.join(' | ')}`);
}

main()
  .catch(err => { console.error('\nSUITE BROKE:', err); failed++; })
  .finally(async () => {
    for (const id of made) {
      await prisma.productImage.deleteMany({ where: { productId: id } }).catch(() => {});
      await prisma.productVariant.deleteMany({ where: { productId: id } }).catch(() => {});
      await prisma.product.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  });
