/**
 * Photographs belong to a colour, not to the product.
 *
 * A shop selling one saree in five colours photographed one of them and every colour showed
 * that picture. This proves the new shape end to end, and -- more importantly -- proves the
 * three things that go quietly wrong when photographs move from a product to its colours:
 *
 *   1. ONE photograph, MANY rows, ONE file. A photograph of the red saree is registered
 *      against red/S, red/M and red/L. Deleting one of those rows must not blank the others,
 *      which it would if the file were removed the first time any row using it went.
 *   2. "The primary photograph" stopped being one row. addImage has always cleared the
 *      previous primary scoped BY VARIANT, so a product in three colours now has three
 *      primaries -- and every screen that said "take the primary, take 1" started returning
 *      an arbitrary colour.
 *   3. The feed a merchant's own website reads must not triple in size because a colour has
 *      three sizes.
 *
 * Runs against a throwaway shop of its own and removes it at the end, because it deletes
 * photographs and counts rows -- neither of which may touch a real shop's saree.
 *
 *   npx tsx src/scripts/verify-product-photos.ts
 */
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { imageService } from '../services/image.service';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';
import { garmentFor } from '../services/online-shop/tryon';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const SHOP = `photos-${Date.now()}`;
const OTHER = `photos-other-${Date.now()}`;

/** A photograph's row, without going anywhere near real storage. */
const shot = (over: any = {}) => ({
  url: `https://example.test/${crypto.randomUUID()}.jpg`,
  imageType: 'GALLERY' as const,
  orderIndex: 0,
  isPrimary: false,
  generated: false,
  ...over
});

async function main() {
  console.log(`\nPHOTOGRAPHS PER COLOUR  (throwaway shop ${SHOP})\n`);

  // ── Setup ───────────────────────────────────────────────────────────────────────────────
  const product = await prisma.product.create({
    data: {
      clientId: SHOP, productCode: 'PRD-PHOTO', title: 'Photo Test Saree', slug: `photo-test-${Date.now()}`,
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, status: 'ACTIVE' as any, basePrice: 2500
    }
  });
  // Red in three sizes, blue in one: the red ones share a photograph, blue has its own.
  const sizes = ['S', 'M', 'L'];
  const red = await Promise.all(sizes.map((size, i) => prisma.productVariant.create({
    data: {
      clientId: SHOP, productId: product.id, sku: `PHOTO-RED-${size}`,
      variantCode: `PHOTO-RED-${size}`, size, colorName: 'Red', hexCode: '#ff0000', sellingPrice: 2500
    }
  })));
  const blue = await prisma.productVariant.create({
    data: {
      clientId: SHOP, productId: product.id, sku: 'PHOTO-BLUE-S',
      variantCode: 'PHOTO-BLUE-S', size: 'S', colorName: 'Blue', hexCode: '#0000ff', sellingPrice: 2500
    }
  });

  const otherProduct = await prisma.product.create({
    data: {
      clientId: OTHER, productCode: 'PRD-OTHER', title: 'Another Shop Saree', slug: `other-shop-${Date.now()}`,
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, status: 'ACTIVE' as any, basePrice: 999
    }
  });
  const otherVariant = await prisma.productVariant.create({
    data: {
      clientId: OTHER, productId: otherProduct.id, sku: 'OTHER-S',
      variantCode: 'OTHER-S', size: 'S', colorName: 'Green', hexCode: '#00ff00', sellingPrice: 999
    }
  });

  // ── A. A photograph names the colour it is of ───────────────────────────────────────────
  console.log('\nA. A PHOTOGRAPH NAMES ITS COLOUR');

  const redFlatLay = await imageService.addImage(product.id, SHOP, shot({ variantId: red[0].id, isPrimary: true }));
  check('a photograph can be saved against one colour', redFlatLay.variantId === red[0].id, String(redFlatLay.variantId));
  check('  ...and is recorded as the shop\'s own, not generated', redFlatLay.generated === false, String(redFlatLay.generated));

  const view = await imageService.addImage(product.id, SHOP, shot({
    variantId: red[0].id, generated: true, generatedFromId: redFlatLay.id, orderIndex: 1
  }));
  check('a generated view records the photograph it was made from', view.generatedFromId === redFlatLay.id, String(view.generatedFromId));

  // ── B. What it refuses ──────────────────────────────────────────────────────────────────
  console.log('\nB. WHAT IT REFUSES');

  const foreignVariant = await imageService
    .addImage(product.id, SHOP, shot({ variantId: otherVariant.id }))
    .then(() => null).catch((e: any) => e);
  check('a colour belonging to another shop is refused',
    foreignVariant?.statusCode === 400, JSON.stringify(foreignVariant?.message));

  const foreignSource = await imageService
    .addImage(product.id, SHOP, shot({ variantId: red[0].id, generated: true, generatedFromId: crypto.randomUUID() }))
    .then(() => null).catch((e: any) => e);
  check('claiming to be generated from a photograph that is not this product\'s is refused',
    foreignSource?.statusCode === 400, JSON.stringify(foreignSource?.message));

  const foreignProduct = await imageService
    .addImage(otherProduct.id, SHOP, shot())
    .then(() => null).catch((e: any) => e);
  check('another shop\'s product is not reachable at all',
    foreignProduct?.statusCode === 404, JSON.stringify(foreignProduct?.message));

  // ── C. One photograph, three sizes, one file ────────────────────────────────────────────
  console.log('\nC. ONE PHOTOGRAPH, THREE SIZES, ONE FILE');

  // What publishing does: the bytes go up once, and every size of the colour points at them.
  const sharedPath = `${SHOP}/${product.id}/shared-red.jpg`;
  const sharedUrl = 'https://example.test/shared-red.jpg';
  const sharedRows = [];
  for (const v of red) {
    sharedRows.push(await imageService.addImage(product.id, SHOP, shot({
      variantId: v.id, url: sharedUrl, storagePath: sharedPath, orderIndex: 2
    })));
  }
  check('every size of the colour carries the photograph', sharedRows.length === 3);
  check('  ...and they all point at the one file',
    new Set(sharedRows.map(r => r.storagePath)).size === 1, sharedRows.map(r => r.storagePath).join(' | '));

  // Deleting one size's copy must leave the other two showing a picture. If the file were
  // removed here, red/S and red/L would become broken images on the shop's own page.
  await imageService.deleteImage(sharedRows[1].id, SHOP);
  const stillThere = await prisma.productImage.count({ where: { storagePath: sharedPath } });
  check('deleting one size\'s copy leaves the other two', stillThere === 2, String(stillThere));

  await imageService.deleteImage(sharedRows[0].id, SHOP);
  await imageService.deleteImage(sharedRows[2].id, SHOP);
  const gone = await prisma.productImage.count({ where: { storagePath: sharedPath } });
  check('  ...and removing the last one leaves nothing behind', gone === 0, String(gone));

  // ── D. Each colour has its own lead photograph ──────────────────────────────────────────
  console.log('\nD. EACH COLOUR HAS ITS OWN LEAD PHOTOGRAPH');

  const bluePhoto = await imageService.addImage(product.id, SHOP, shot({ variantId: blue.id, isPrimary: true }));
  const primaries = await prisma.productImage.findMany({
    where: { productId: product.id, isPrimary: true }, select: { variantId: true }
  });
  check('setting blue\'s lead photograph does not unset red\'s',
    primaries.length === 2 && primaries.some(p => p.variantId === red[0].id) && primaries.some(p => p.variantId === blue.id),
    JSON.stringify(primaries));

  // ── E. The shop's own photographs lead ──────────────────────────────────────────────────
  console.log('\nE. THE SHOP\'S OWN PHOTOGRAPHS LEAD');

  const listed = await imageService.getImages(product.id, SHOP);
  const firstGenerated = listed.findIndex(i => i.generated);
  const lastOwn = listed.map(i => i.generated).lastIndexOf(false);
  check('every photograph the shop took is listed before every generated one',
    firstGenerated === -1 || firstGenerated > lastOwn,
    listed.map(i => (i.generated ? 'generated' : 'own')).join(', '));

  // ── F. The feed a merchant's website reads ──────────────────────────────────────────────
  console.log('\nF. THE FEED A MERCHANT\'S WEBSITE READS');

  // The same photograph on three sizes again, to prove the feed says it once.
  const feedRows = [];
  for (const v of red) {
    feedRows.push(await imageService.addImage(product.id, SHOP, shot({
      variantId: v.id, url: 'https://example.test/feed-red.jpg', orderIndex: 5
    })));
  }
  const feed: any = await storefrontCatalogueService
    .getProduct({ clientId: SHOP, locationIds: [] }, product.productCode)
    .catch((e: any) => ({ error: e?.message }));
  const urls: string[] = (feed?.images ?? []).map((i: any) => i.url);
  check('the product is in the feed', Array.isArray(feed?.images), JSON.stringify(feed).slice(0, 160));
  check('one photograph on three sizes is sent once, not three times',
    urls.filter(u => u === 'https://example.test/feed-red.jpg').length === 1, urls.join(', '));
  check('  ...and no photograph is repeated at all',
    urls.length === new Set(urls).size, urls.join(', '));

  const ownFirst = (feed?.images ?? []).findIndex((i: any) => i.url === 'https://example.test/feed-red.jpg');
  const generatedAt = (feed?.images ?? []).findIndex((i: any) => i.url === view.url);
  check('the shop\'s own photograph comes before the generated one',
    ownFirst >= 0 && (generatedAt === -1 || ownFirst < generatedAt), `own@${ownFirst} generated@${generatedAt}`);

  // ── F2. The star a shop presses actually moves the photograph ───────────────────────────
  console.log('\nF2. MARKING A DIFFERENT PHOTOGRAPH AS THE MAIN ONE');

  /*
   * Reported by a shop owner: they set another photograph as the main one for a colour, and the
   * shop kept showing the old picture. The feed was ordered without isPrimary, so the star moved
   * the badge in the admin and nothing else.
   *
   * Checked on ONE COLOUR, not on the first row of the whole feed -- the feed carries every
   * colour, and the shop's product page ranks the chosen colour's photographs to the front and
   * keeps this order within that group. The first row of the feed is a different question.
   */
  const redCode = (await prisma.productVariant.findUniqueOrThrow({ where: { id: red[0].id }, select: { variantCode: true } })).variantCode;
  const redShots = async () => {
    const f: any = await storefrontCatalogueService.getProduct({ clientId: SHOP, locationIds: [] }, product.productCode);
    return (f?.images ?? []).filter((i: any) => i.variantCode === redCode).map((i: any) => i.url);
  };

  const beforeStar = await redShots();
  check('this colour has more than one photograph to choose between', beforeStar.length > 1, String(beforeStar.length));
  const notLeading = (await prisma.productImage.findMany({
    where: { productId: product.id, variantId: red[0].id, isPrimary: false }, select: { id: true, url: true }
  }))[0];
  if (notLeading) {
    await imageService.updateImage(notLeading.id, SHOP, { isPrimary: true });
    const afterStar = await redShots();
    check('marking a photograph as the main one puts it first for the shopper',
      afterStar[0] === notLeading.url, `${afterStar[0]} vs ${notLeading.url}`);
    check('  ...and the rest are still there, not lost',
      afterStar.length === beforeStar.length, `${afterStar.length} vs ${beforeStar.length}`);
  } else {
    check('there was a second photograph on this colour to promote', false, 'none found');
  }

  // ── F3. Try-on sends the front view of the colour on screen ────────────────────
  console.log('\nF3. TRY-ON SENDS THE FRONT VIEW OF THE COLOUR ON SCREEN');

  /*
   * A shopper looking at the blue saree must be tried on in the BLUE one, using the front view.
   *
   * Both halves were wrong before: try-on sent whichever photograph led the whole product, and
   * nothing in the database said which photograph was the front view at all.
   */
  const frontRed = await imageService.addImage(product.id, SHOP, shot({
    variantId: red[1].id, generated: true, view: 'front', url: 'https://example.test/red-front.jpg', orderIndex: 9
  }));
  const frontBlue = await imageService.addImage(product.id, SHOP, shot({
    variantId: blue.id, generated: true, view: 'front', url: 'https://example.test/blue-front.jpg', orderIndex: 9
  }));
  await imageService.addImage(product.id, SHOP, shot({
    variantId: blue.id, generated: true, view: 'back', url: 'https://example.test/blue-back.jpg', orderIndex: 10
  }));

  const redCodes = await prisma.productVariant.findMany({ where: { id: { in: red.map(v => v.id) } }, select: { variantCode: true } });
  const blueCode = (await prisma.productVariant.findUniqueOrThrow({ where: { id: blue.id }, select: { variantCode: true } })).variantCode;

  const wornBlue = await garmentFor(SHOP, product.productCode, blueCode);
  check('a shopper on blue is tried on in the BLUE front view',
    wornBlue?.imageUrl === frontBlue.url, String(wornBlue?.imageUrl));

  /*
   * Asked for the size the front view is NOT filed against. A colour is several variants and one
   * photograph of it is registered on each, but a shop can end up with it on only one -- picking
   * red in size S must not lose a photograph filed under red in M.
   */
  const wornRedOtherSize = await garmentFor(SHOP, product.productCode, redCodes[0].variantCode);
  check('  ...and asking by another SIZE of the same colour still finds that colour front view',
    wornRedOtherSize?.imageUrl === frontRed.url, String(wornRedOtherSize?.imageUrl));

  const wornUnknown = await garmentFor(SHOP, product.productCode, 'NO-SUCH-VARIANT');
  check('  ...an unknown colour still gets a real garment rather than a refusal',
    !!wornUnknown?.imageUrl, String(wornUnknown?.imageUrl));

  // ── G. A product with no colours keeps its photographs ──────────────────────────────────
  console.log('\nG. A PRODUCT WITH NO COLOURS KEEPS ITS PHOTOGRAPHS');

  const plain = await prisma.product.create({
    data: {
      clientId: SHOP, productCode: 'PRD-PLAIN', title: 'Alteration Service', slug: `alteration-${Date.now()}`,
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, status: 'ACTIVE' as any, basePrice: 100
    }
  });
  const loose = await imageService.addImage(plain.id, SHOP, shot());
  check('a photograph with no colour is still allowed', loose.variantId === null, String(loose.variantId));
  check('  ...and is found by reading the product', (await imageService.getImages(plain.id, SHOP)).length === 1);

  // ── Cleanup ─────────────────────────────────────────────────────────────────────────────
  for (const id of [SHOP, OTHER]) {
    await prisma.productImage.deleteMany({ where: { product: { clientId: id } } });
    await prisma.productVariant.deleteMany({ where: { clientId: id } });
    await prisma.product.deleteMany({ where: { clientId: id } });
  }
  const leftBehind = await prisma.product.count({ where: { clientId: { in: [SHOP, OTHER] } } });
  check('the throwaway shops are gone', leftBehind === 0, String(leftBehind));

  console.log(`\n${passed} passed | ${failed} failed`);
  if (failures.length) console.log('Failed:\n  - ' + failures.join('\n  - '));
}

main()
  .catch(e => { console.error('STOPPED:', e); failed++; process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
