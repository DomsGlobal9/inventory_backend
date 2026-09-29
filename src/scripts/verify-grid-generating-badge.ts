/**
 * A colour whose photographs are being made says so on its card in the product list.
 *
 * The polling check drove this with a job row written by hand. This one goes through the REAL
 * queue -- the same call the wizard makes after publishing -- because the card matches a job to a
 * colour by variant id, and hand-writing the row is exactly the step that would hide a mismatch
 * between what enqueue stores and what the list returns.
 *
 *   npx tsx src/scripts/verify-grid-generating-badge.ts
 */
import { prisma } from '../lib/prisma';
import { photoJobQueue } from '../services/photo-jobs/queue';
import { productService } from '../services/product.service';

const CLIENT = `badge-${Date.now()}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

async function main() {
  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'BADGE-1', slug: 'badge-1', title: 'Badge saree',
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree',
      basePrice: 5000 as any, status: 'ACTIVE' as any, publishedAt: new Date()
    }
  });

  // One colour in two sizes, which is the ordinary shape and the one that makes the id matching
  // worth checking: the list carries an entry per VARIANT, the job carries every variant of a
  // COLOUR.
  const sizes = ['S', 'M'];
  const variantIds: string[] = [];
  for (const size of sizes) {
    const v = await prisma.productVariant.create({
      data: {
        productId: product.id, clientId: CLIENT, colorName: 'Firebrick', size,
        variantCode: `BADGE-1-${size}`, sku: `BADGE-1-${size}-SKU`, sellingPrice: 29500 as any
      }
    });
    variantIds.push(v.id);
    await prisma.productImage.create({
      data: {
        productId: product.id, variantId: v.id, imageType: 'RAW_UPLOAD' as any,
        orderIndex: 0, url: 'https://cdn.example.com/flatlay.jpg', isPrimary: true
      }
    });
  }

  console.log('\nA. THE WIZARD QUEUES THE JOB IT SAYS IT QUEUES');
  const { made, refused } = await photoJobQueue.enqueue({
    clientId: CLIENT, productId: product.id, kind: 'VIEWS', colours: ['Firebrick']
  } as any);
  check('a job is queued for the colour', made.length === 1, JSON.stringify(refused));

  const job = await prisma.photoJob.findFirst({
    where: { productId: product.id }, select: { status: true, variantIds: true, viewsDone: true, viewsTotal: true }
  });
  check('and it starts QUEUED, which is a state the list looks for',
    job?.status === 'QUEUED', String(job?.status));
  check('carrying every size of that colour',
    variantIds.every(id => (job?.variantIds ?? []).includes(id)),
    `${job?.variantIds?.length} ids for ${variantIds.length} sizes`);

  console.log('\nB. AND THE PRODUCT LIST TELLS THE CARD ABOUT IT');
  const list: any = await productService.getProducts(CLIENT, { page: 1, limit: 20 } as any);
  const row = (list.data ?? list).find((p: any) => p.id === product.id);
  check('the product comes back', !!row);
  check('with the job on it', Array.isArray(row?.generating) && row.generating.length === 1,
    JSON.stringify(row?.generating));
  check('naming the variants it is for, which is how the card matches a colour',
    (row?.generating?.[0]?.variantIds ?? []).length === variantIds.length,
    JSON.stringify(row?.generating?.[0]?.variantIds?.length));
  check('and the progress the card prints',
    row?.generating?.[0]?.viewsTotal === 4, JSON.stringify(row?.generating?.[0]));

  console.log('\nC. THE CARD CAN ACTUALLY FIND IT');
  /*
   * The match the card makes, done here rather than in a browser: every colour on the card looks
   * for a job whose variantIds contain that colour's own id. If these two drift apart the badge
   * silently never appears, which is the bug being chased.
   */
  const colours = row?.colours ?? [];
  check('the list carries the colours too', colours.length === 2, String(colours.length));
  const matched = colours.filter((c: any) =>
    (row.generating ?? []).some((j: any) => (j.variantIds ?? []).includes(c.id))
  );
  check('and EVERY colour finds the job that is making its photographs',
    matched.length === colours.length, `${matched.length} of ${colours.length}`);

  console.log('\nD. IT STOPS SAYING SO WHEN THE JOB IS OVER');
  await prisma.photoJob.updateMany({ where: { productId: product.id }, data: { status: 'DONE' } });
  const after: any = await productService.getProducts(CLIENT, { page: 1, limit: 20 } as any);
  const afterRow = (after.data ?? after).find((p: any) => p.id === product.id);
  check('a finished job is not still announced',
    (afterRow?.generating ?? []).length === 0, JSON.stringify(afterRow?.generating));

  console.log('\nE. A FAILED ONE IS NOT ANNOUNCED EITHER');
  await prisma.photoJob.updateMany({ where: { productId: product.id }, data: { status: 'FAILED' } });
  const failedList: any = await productService.getProducts(CLIENT, { page: 1, limit: 20 } as any);
  const failedRow = (failedList.data ?? failedList).find((p: any) => p.id === product.id);
  check('a failed job does not leave the card spinning forever',
    (failedRow?.generating ?? []).length === 0, JSON.stringify(failedRow?.generating));

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);

  const w = { clientId: CLIENT };
  await prisma.photoJob.deleteMany({ where: w }).catch(() => {});
  await prisma.productImage.deleteMany({ where: { product: w } }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(async e => {
  console.log('CRASHED:', e.message);
  const w = { clientId: CLIENT };
  await prisma.photoJob.deleteMany({ where: w }).catch(() => {});
  await prisma.productImage.deleteMany({ where: { product: w } }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
