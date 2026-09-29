/**
 * What a customer gets when they scan the QR code on a garment.
 *
 * Two things were wrong, and they are the same thing twice. A product QR names no colour, so the
 * page had nothing to offer and tried the shopper on in whatever the shop happened to lead with.
 * And the GENERATE call resolved the product without the colour at all -- so even a swing tag
 * that correctly SHOWED the goldenrod one produced the shopper wearing the cover. The lookup
 * honoured the colour; the generation quietly ignored it.
 *
 * The caller here is anonymous, so this also checks what is NOT returned: no price, no stock, no
 * ids, and nothing at all about a product the shop has not published.
 *
 *   npx tsx src/scripts/verify-shopper-scan-colours.ts
 */
import { prisma } from '../lib/prisma';
import { shopperTryOnProductService } from '../services/shopper-tryon';

const CLIENT = `scan-${Date.now()}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

const IMG = (n: string) => `https://cdn.example.com/${n}.jpg`;

async function main() {
  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'SCAN-1', slug: 'scan-1', title: 'Scanned saree',
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree',
      basePrice: 5000 as any, status: 'ACTIVE' as any, publishedAt: new Date()
    }
  });
  await prisma.productImage.create({
    data: { productId: product.id, imageType: 'COVER' as any, orderIndex: 0, url: IMG('cover'), isPrimary: true }
  });

  const mk = async (code: string, colour: string | null, size: string, photo: string | null) => {
    const v = await prisma.productVariant.create({
      data: {
        productId: product.id, clientId: CLIENT, colorName: colour, size,
        variantCode: code, sku: `${code}-SKU`, sellingPrice: 5000 as any
      }
    });
    if (photo) {
      await prisma.productImage.create({
        data: {
          productId: product.id, variantId: v.id, imageType: 'GALLERY' as any,
          orderIndex: 0, url: photo, isPrimary: true
        }
      });
    }
    return v;
  };

  await mk('SCAN-GOLD-S', 'Goldenrod', 'S', IMG('gold'));
  await mk('SCAN-GOLD-M', 'Goldenrod', 'M', IMG('gold'));   // same colour, another size
  await mk('SCAN-CRIM', 'Crimson', 'Free', IMG('crimson'));
  await mk('SCAN-PLAIN', 'Unshot', 'Free', null);           // no photograph of its own

  console.log('\nA. THE SCAN OFFERS THE COLOURS ON THE RACK');
  const colours = await shopperTryOnProductService.coloursFor(CLIENT, 'SCAN-1');
  check('the colours come back at all', colours.length > 0, `${colours.length}`);
  check('one entry per COLOUR, not one per size',
    colours.length === 3, JSON.stringify(colours.map(c => c.colourName)));
  check('each carries its own photograph',
    colours.find(c => c.colourName === 'Crimson')?.imageUrl === IMG('crimson'),
    String(colours.find(c => c.colourName === 'Crimson')?.imageUrl));
  check('a colour with no photograph of its own still appears, wearing the cover',
    colours.find(c => c.colourName === 'Unshot')?.imageUrl === IMG('cover'),
    String(colours.find(c => c.colourName === 'Unshot')?.imageUrl));
  check('and each carries the code the try-on needs to name it',
    colours.every(c => typeof c.variantCode === 'string' && c.variantCode.length > 0));

  console.log('\nB. AND NOTHING A STRANGER SHOULD NOT HAVE');
  const keys = new Set(colours.flatMap(c => Object.keys(c)));
  check('no price, no stock, no database ids',
    [...keys].sort().join() === 'colourName,imageUrl,variantCode', JSON.stringify([...keys]));

  console.log('\nC. GENERATING USES THE COLOUR THAT WAS CHOSEN');
  /*
   * The bug: the generate route resolved without the variant, so this came back as the cover.
   * Checked at the resolver, which is what that route calls.
   */
  const chosen = await shopperTryOnProductService.resolve(CLIENT, 'SCAN-1', 'SCAN-CRIM');
  check('a named colour resolves to THAT photograph', chosen?.imageUrl === IMG('crimson'), String(chosen?.imageUrl));
  check('and says which colour it is', (chosen as any)?.colourName === 'Crimson', String((chosen as any)?.colourName));

  const unnamed = await shopperTryOnProductService.resolve(CLIENT, 'SCAN-1');
  check('no colour named still resolves, as every tag printed before this does',
    unnamed?.imageUrl === IMG('cover'), String(unnamed?.imageUrl));

  const nonsense = await shopperTryOnProductService.resolve(CLIENT, 'SCAN-1', 'NOT-A-CODE');
  check('a code this product does not have falls back rather than failing',
    nonsense?.imageUrl === IMG('cover'), String(nonsense?.imageUrl));

  const hostile = await shopperTryOnProductService.resolve(CLIENT, 'SCAN-1', '../../etc/passwd');
  check('and a code that is not a code is dropped', hostile?.imageUrl === IMG('cover'), String(hostile?.imageUrl));

  console.log('\nD. ANOTHER SHOP CANNOT BE REACHED BY GUESSING');
  const other = await shopperTryOnProductService.coloursFor('someone-else', 'SCAN-1');
  check('the same product code under another shop offers nothing', other.length === 0, JSON.stringify(other));

  console.log('\nE. AN UNPUBLISHED GARMENT IS NOT ON THE RACK');
  await prisma.product.update({ where: { id: product.id }, data: { status: 'DRAFT' as any } });
  const draftColours = await shopperTryOnProductService.coloursFor(CLIENT, 'SCAN-1');
  check('a draft offers no colours', draftColours.length === 0, JSON.stringify(draftColours));
  check('and does not resolve at all',
    (await shopperTryOnProductService.resolve(CLIENT, 'SCAN-1')) === null);

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);

  const w = { clientId: CLIENT };
  await prisma.productImage.deleteMany({ where: { product: w } }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => {
  console.log('CRASHED:', e.message);
  const w = { clientId: CLIENT };
  await prisma.productImage.deleteMany({ where: { product: w } }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
