/**
 * Editing a product: what a new base price carries with it, and what it leaves alone.
 *
 * The rule a shopkeeper was promised: variants that were FOLLOWING the global price move with it;
 * variants somebody priced on purpose keep their own. Worth a permanent test because it is money,
 * and because the wrong answer in either direction is silent -- either the till keeps charging the
 * old price, or a deliberate price is quietly overwritten.
 */
import { prisma } from '../lib/prisma';
import { productService } from '../services/product.service';

const CLIENT = `prod-edit-${Date.now()}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

async function main() {
  const stamp = Date.now();
  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: `PE-${stamp}`, slug: `pe-${stamp}`,
      title: 'Kanchi Pattu Floral Zari Saree', description: 'The description as first written.',
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any,
      dressType: 'Saree', fabric: 'Kanchi Pattu', brand: 'Swathi Designer Studio',
      basePrice: 29500, status: 'DRAFT' as any
    }
  });

  // One variant following the global price, one priced on purpose.
  const follower = await prisma.productVariant.create({
    data: {
      productId: product.id, clientId: CLIENT, colorName: 'Goldenrod', size: 'Free Size',
      variantCode: `PEV-${stamp}-F`, sku: `PES-${stamp}-F`, sellingPrice: 29500
    }
  });
  const deliberate = await prisma.productVariant.create({
    data: {
      productId: product.id, clientId: CLIENT, colorName: 'Crimson', size: 'XL',
      variantCode: `PEV-${stamp}-D`, sku: `PES-${stamp}-D`, sellingPrice: 31000
    }
  });

  console.log('\nA. WHAT THE SCREEN PROMISES BEFORE SAVING');
  const impact = await productService.variantsFollowingBase(product.id, CLIENT, 24500);
  check('it says exactly one variant will follow', impact.follow === 1, JSON.stringify(impact));
  check('and one keeps its own price', impact.keepTheirOwn === 1, JSON.stringify(impact));

  const same = await productService.variantsFollowingBase(product.id, CLIENT, 29500);
  check('the same price moves nothing', same.follow === 0 && same.keepTheirOwn === 0,
    JSON.stringify(same));

  console.log('\nB. WHAT SAVING ACTUALLY DOES');
  const saved: any = await productService.updateProduct(product.id, CLIENT, {
    basePrice: 24500,
    description: 'Rewritten by the shopkeeper.',
    brand: 'Swathi Designer Studio',
    fabric: 'Kanchipuram Silk',
    hsnCode: '5007',
    taxRateBps: 500
  });
  check('the product keeps the edited description',
    saved.description === 'Rewritten by the shopkeeper.', saved.description);
  check('and the edited fabric', saved.fabric === 'Kanchipuram Silk', saved.fabric);
  check('and the HSN and rate a tax invoice needs',
    saved.hsnCode === '5007' && saved.taxRateBps === 500,
    `${saved.hsnCode} / ${saved.taxRateBps}`);
  check('the base price is the new one', Number(saved.basePrice) === 24500, String(saved.basePrice));
  check('and it reports how many variants followed', saved.variantsRepriced === 1,
    String(saved.variantsRepriced));

  const f = await prisma.productVariant.findUnique({ where: { id: follower.id }, select: { sellingPrice: true } });
  const d = await prisma.productVariant.findUnique({ where: { id: deliberate.id }, select: { sellingPrice: true } });
  check('the variant that followed the old base now follows the new one',
    Number(f?.sellingPrice) === 24500, String(f?.sellingPrice));
  check('the one priced on purpose was left alone',
    Number(d?.sellingPrice) === 31000, String(d?.sellingPrice));

  console.log('\nC. EDITING ANYTHING ELSE LEAVES PRICES WHERE THEY ARE');
  const again: any = await productService.updateProduct(product.id, CLIENT, {
    description: 'Changed again, no price this time.'
  });
  check('no variant moved', again.variantsRepriced === 0, String(again.variantsRepriced));
  const f2 = await prisma.productVariant.findUnique({ where: { id: follower.id }, select: { sellingPrice: true } });
  check('the follower kept the price it had', Number(f2?.sellingPrice) === 24500, String(f2?.sellingPrice));

  console.log('\nD. CLEARING THE HSN MEANS NOT SET, NOT EMPTY');
  const cleared: any = await productService.updateProduct(product.id, CLIENT, { hsnCode: '' });
  check('an emptied HSN is stored as null, so nothing reads it as a code',
    cleared.hsnCode === null, JSON.stringify(cleared.hsnCode));

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);

  const w = { clientId: CLIENT };
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => { console.log('CRASHED:', e.message); await prisma.$disconnect(); process.exit(1); });
