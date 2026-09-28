/**
 * What the product list, the variant list and a scanned tag promise the screens that read them.
 *
 * All of it added over one afternoon -- a photo grid, swing tags, a per-colour try-on link -- and
 * every one of those features is a screen reading a field that has to be there. The bugs in this
 * area were all the same bug: the field was missing and the screen rendered nothing, while the
 * request behind it returned a perfectly good answer.
 *
 *   npx tsx src/scripts/verify-catalogue-views.ts
 */
import { prisma } from '../lib/prisma';
import { productService } from '../services/product.service';
import { variantService } from '../services/variant.service';
import { shopperTryOnProductService } from '../services/shopper-tryon';

const CLIENT = `cat-views-${Date.now()}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

async function main() {
  const stamp = Date.now() % 100000;

  const location = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Counter', code: `CV-${stamp}`, type: 'STORE' as any, active: true }
  });

  // One product with photographs, one with none: the grid has to tell them apart.
  const withPhoto = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: `CVA-${stamp}`, slug: `cva-${stamp}`,
      title: 'Kanchipuram Silk Saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
      dressType: 'Saree', fabric: 'Silk', basePrice: 29500,
      status: 'ACTIVE' as any, publishedAt: new Date(), hsnCode: '5007', taxRateBps: 500
    }
  });
  const bare = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: `CVB-${stamp}`, slug: `cvb-${stamp}`,
      title: 'Unphotographed Saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
      dressType: 'Saree', basePrice: 1200, status: 'DRAFT' as any
    }
  });

  const gold = await prisma.productVariant.create({
    data: {
      productId: withPhoto.id, clientId: CLIENT, colorName: 'Goldenrod', size: 'Free Size',
      variantCode: `CVV-${stamp}-G`, sku: `CVS-${stamp}-G`, sellingPrice: 29500, barcode: `SVM-CV${stamp}G`
    }
  });
  const crimson = await prisma.productVariant.create({
    data: {
      productId: withPhoto.id, clientId: CLIENT, colorName: 'Crimson', size: 'Free Size',
      variantCode: `CVV-${stamp}-C`, sku: `CVS-${stamp}-C`, sellingPrice: 31000, barcode: null
    }
  });
  await prisma.productVariant.create({
    data: {
      productId: bare.id, clientId: CLIENT, colorName: 'Plain', size: 'Free Size',
      variantCode: `CVV-${stamp}-P`, sku: `CVS-${stamp}-P`, sellingPrice: 1200
    }
  });

  await prisma.inventoryStock.create({
    data: { clientId: CLIENT, variantId: gold.id, locationId: location.id, quantity: 7, reservedQty: 0 }
  });

  // Two photographs on the product, one of them the cover, and one tied to a colour.
  await prisma.productImage.create({
    data: {
      productId: withPhoto.id, imageType: 'GALLERY' as any, orderIndex: 1,
      url: 'https://example.com/second.jpg', isPrimary: false
    }
  });
  await prisma.productImage.create({
    data: {
      productId: withPhoto.id, imageType: 'COVER' as any, orderIndex: 0,
      url: 'https://example.com/cover.jpg', isPrimary: true
    }
  });
  await prisma.productImage.create({
    data: {
      productId: withPhoto.id, variantId: gold.id, imageType: 'GALLERY' as any, orderIndex: 0,
      url: 'https://example.com/goldenrod.jpg', isPrimary: true
    }
  });

  console.log('\nA. THE PHOTO GRID HAS A PHOTOGRAPH TO SHOW');
  const list: any = await productService.getProducts(CLIENT, { page: 1, limit: 50 } as any);
  const rows: any[] = list.data ?? list;
  const a = rows.find(r => r.id === withPhoto.id);
  const b = rows.find(r => r.id === bare.id);

  check('the list carries a cover image url', typeof a?.coverImageUrl === 'string', String(a?.coverImageUrl));
  check('and it is the COVER, not whichever photograph came back first',
    a?.coverImageUrl === 'https://example.com/cover.jpg', String(a?.coverImageUrl));
  check('a product with no photograph says null rather than omitting the field',
    b !== undefined && b.coverImageUrl === null, JSON.stringify(b?.coverImageUrl));
  check('one url per product, never the whole gallery',
    (a as any).images === undefined, JSON.stringify(Object.keys(a ?? {}).filter(k => /image/i.test(k))));
  check('the counts the grid shows still come through',
    a?.variantSummary?.totalUnits === 7 && a?.imageCount === 3,
    `units ${a?.variantSummary?.totalUnits}, images ${a?.imageCount}`);

  console.log('\nA2. A CARD PER COLOUR, NOT ONE PER PRODUCT');
  const cols: any[] = a?.colours ?? [];
  check('the list carries the colours themselves', cols.length === 2, String(cols.length));
  check('each with its own price, so two colours at different prices do not show one figure',
    cols.some(c => Number(c.sellingPrice) === 29500) && cols.some(c => Number(c.sellingPrice) === 31000),
    JSON.stringify(cols.map(c => String(c.sellingPrice))));
  check('each with its own stock rather than the product total',
    cols.find(c => c.colorName === 'Goldenrod')?.units === 7 &&
    cols.find(c => c.colorName === 'Crimson')?.units === 0,
    JSON.stringify(cols.map(c => `${c.colorName}:${c.units}`)));
  check('a colour with its own photograph uses it',
    cols.find(c => c.colorName === 'Goldenrod')?.photoUrl === 'https://example.com/goldenrod.jpg',
    String(cols.find(c => c.colorName === 'Goldenrod')?.photoUrl));
  check('a colour without one falls back to the product cover, not to a grey box',
    cols.find(c => c.colorName === 'Crimson')?.photoUrl === 'https://example.com/cover.jpg',
    String(cols.find(c => c.colorName === 'Crimson')?.photoUrl));
  check('a product whose colours have no pictures at all still lists them',
    (b?.colours ?? []).length === 1 && b.colours[0].photoUrl === null,
    JSON.stringify(b?.colours?.map((c: any) => c.photoUrl)));

  console.log('\nB. EVERY VARIANT CARRIES ITS OWN TAG LINK AND PICTURE');
  const variants: any[] = await variantService.getVariants(withPhoto.id, CLIENT);
  const g = variants.find(v => v.id === gold.id);
  const c = variants.find(v => v.id === crimson.id);

  check('a variant has a try-on link of its own',
    typeof g?.tryOnScanUrl === 'string' && g.tryOnScanUrl.length > 0, String(g?.tryOnScanUrl));
  check('and the link names THAT colour, not just the product',
    String(g?.tryOnScanUrl).includes(`variant=${gold.variantCode}`), String(g?.tryOnScanUrl));
  check('two colours get two different links',
    g?.tryOnScanUrl !== c?.tryOnScanUrl, 'same link would print the same tag twice');
  check('the link says a tag produced it, so a scan can be told from a tap',
    String(g?.tryOnScanUrl).includes('source=label-sheet'), String(g?.tryOnScanUrl));
  check('a variant with its own photograph offers it for the picker',
    g?.photoUrl === 'https://example.com/goldenrod.jpg', String(g?.photoUrl));
  check('one without stays null rather than borrowing the product cover',
    c?.photoUrl === null, String(c?.photoUrl));

  console.log('\nC. A SCANNED TAG, IN EVERY STATE A PRINTED TAG CAN BE IN');
  const noVariant = await shopperTryOnProductService.resolve(CLIENT, withPhoto.productCode);
  check('no variant at all resolves to the product, as every tag printed before this does',
    noVariant?.imageUrl === 'https://example.com/cover.jpg', String(noVariant?.imageUrl));
  check('and claims no colour', (noVariant as any)?.variantCode === undefined,
    JSON.stringify((noVariant as any)?.variantCode));

  const named = await shopperTryOnProductService.resolve(CLIENT, withPhoto.productCode, gold.variantCode);
  check('a colour with its own photograph shows THAT photograph',
    named?.imageUrl === 'https://example.com/goldenrod.jpg', String(named?.imageUrl));
  check('and the page is told which colour it is showing',
    (named as any)?.colourName === 'Goldenrod', String((named as any)?.colourName));

  const noPhoto = await shopperTryOnProductService.resolve(CLIENT, withPhoto.productCode, crimson.variantCode);
  check('a colour with no photograph falls back to the cover rather than failing',
    noPhoto?.imageUrl === 'https://example.com/cover.jpg', String(noPhoto?.imageUrl));
  check('and still names the colour, so the shopper knows the tag was read',
    (noPhoto as any)?.colourName === 'Crimson', String((noPhoto as any)?.colourName));

  const nonsense = await shopperTryOnProductService.resolve(CLIENT, withPhoto.productCode, 'NO-SUCH-COLOUR');
  check('a code this product does not have falls back, because a tag outlives its data',
    nonsense?.imageUrl === 'https://example.com/cover.jpg', String(nonsense?.imageUrl));

  const hostile = await shopperTryOnProductService.resolve(CLIENT, withPhoto.productCode, '../../etc/passwd');
  check('and a code that is not a code at all is simply dropped',
    hostile?.imageUrl === 'https://example.com/cover.jpg', String(hostile?.imageUrl));

  const draft = await shopperTryOnProductService.resolve(CLIENT, bare.productCode);
  check('a DRAFT still resolves to nothing, whatever the tag says',
    draft === null, JSON.stringify(draft));

  console.log('\nD. ANOTHER SHOP CANNOT BE REACHED BY GUESSING A CODE');
  const otherShop = await shopperTryOnProductService.resolve('someone-else', withPhoto.productCode, gold.variantCode);
  check('the same product code under another shop resolves to nothing',
    otherShop === null, JSON.stringify(otherShop));

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);

  const w = { clientId: CLIENT };
  await prisma.productImage.deleteMany({ where: { product: w } }).catch(() => {});
  await prisma.inventoryStock.deleteMany({ where: w }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.stockLocation.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => { console.log('CRASHED:', e.message); await prisma.$disconnect(); process.exit(1); });
