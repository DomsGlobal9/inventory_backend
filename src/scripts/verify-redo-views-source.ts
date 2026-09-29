/**
 * Making a set again: what gets sent the second time, and what happens when people are awkward.
 *
 * Two shapes of colour, and they must be re-run from different things.
 *
 *   A colour photographed by the shop  -> the SAME flat-lay, and the same blouse piece with it.
 *   A colour made by recolouring another -> its own FRONT VIEW, because that is all it has ever
 *                                           had. There is no flat-lay of it; it was never
 *                                           photographed.
 *
 * Getting that backwards is not a crash, it is a wrong picture: re-running a recoloured colour
 * from the original colour's flat-lay would quietly give the shop the wrong colour back.
 *
 * The rest is what a shop will actually do to this -- press it twice, press it on a colour that
 * is already running, press it after deleting the photograph it was made from.
 *
 *   npx tsx src/scripts/verify-redo-views-source.ts
 */
import { prisma } from '../lib/prisma';
import { photoJobQueue } from '../services/photo-jobs/queue';

const CLIENT = `redo-${Date.now()}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};
const IMG = (n: string) => `https://cdn.example.com/${n}.jpg`;

let product: any;

/** A colour with a full set of views, made either from its own flat-lay or by recolouring. */
async function colour(name: string, opts: { flatLay?: boolean; blouse?: boolean }) {
  const v = await prisma.productVariant.create({
    data: {
      productId: product.id, clientId: CLIENT, colorName: name, size: 'Free',
      variantCode: `V-${name}`, sku: `S-${name}`, sellingPrice: 5000 as any
    }
  });
  let from: any = null;
  if (opts.flatLay) {
    from = await prisma.productImage.create({
      data: {
        productId: product.id, variantId: v.id, imageType: 'RAW_UPLOAD' as any,
        orderIndex: 0, url: IMG(`${name}-flatlay`), slot: 'saree'
      }
    });
  }
  if (opts.blouse) {
    await prisma.productImage.create({
      data: {
        productId: product.id, variantId: v.id, imageType: 'RAW_UPLOAD' as any,
        orderIndex: 1, url: IMG(`${name}-blouse`), slot: 'blouse'
      }
    });
  }
  for (const [i, view] of ['front', 'left', 'right', 'back'].entries()) {
    await prisma.productImage.create({
      data: {
        productId: product.id, variantId: v.id, imageType: 'GALLERY' as any,
        orderIndex: i + 2, url: IMG(`${name}-${view}`), generated: true, view,
        isPrimary: view === 'front', generatedFromId: from?.id ?? null
      }
    });
  }
  return v;
}

const queue = async (name: string) => photoJobQueue.enqueue({
  clientId: CLIENT, productId: product.id, kind: 'VIEWS', colours: [name]
} as any);

const jobFor = async (name: string) => prisma.photoJob.findFirst({
  where: { productId: product.id, colourName: name },
  orderBy: { createdAt: 'desc' },
  select: { id: true, sourceImageUrl: true, referenceUrls: true, status: true }
});

async function main() {
  product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: 'REDO-SRC', slug: 'redo-src', title: 'Redo source saree',
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree',
      basePrice: 5000 as any, status: 'ACTIVE' as any, publishedAt: new Date()
    }
  });

  console.log('\nA. A COLOUR THE SHOP PHOTOGRAPHED: THE SAME FLAT-LAY AND BLOUSE AGAIN');
  await colour('Firebrick', { flatLay: true, blouse: true });
  const r1 = await queue('Firebrick');
  check('it queues', r1.made.length === 1, JSON.stringify(r1.refused));
  const j1: any = await jobFor('Firebrick');
  check('worked from the flat-lay it was made from, not from its own front view',
    j1.sourceImageUrl === IMG('Firebrick-flatlay'), j1.sourceImageUrl);
  check('and the blouse piece goes with it again',
    j1.referenceUrls?.blouse === IMG('Firebrick-blouse'), JSON.stringify(j1.referenceUrls));

  console.log('\nB. A COLOUR MADE BY RECOLOURING: ITS OWN FRONT VIEW');
  /*
   * This colour has no flat-lay and never had one -- it exists because somebody recoloured
   * another colour's front view. The only picture of it IS that front view.
   */
  await colour('Indigo', {});
  const r2 = await queue('Indigo');
  check('it queues', r2.made.length === 1, JSON.stringify(r2.refused));
  const j2: any = await jobFor('Indigo');
  check('worked from the front view it already has',
    j2.sourceImageUrl === IMG('Indigo-front'), j2.sourceImageUrl);
  check('and takes no flat blouse piece, because there is none of this colour',
    j2.referenceUrls === null || Object.keys(j2.referenceUrls ?? {}).length === 0,
    JSON.stringify(j2.referenceUrls));
  check('and it did NOT reach for another colour\'s flat-lay',
    j2.sourceImageUrl !== IMG('Firebrick-flatlay'), j2.sourceImageUrl);

  console.log('\nC. PRESSING IT TWICE');
  const again = await queue('Firebrick');
  check('the second press is refused rather than queued twice',
    again.made.length === 0 && again.refused.length === 1, JSON.stringify(again));
  check('and says why, in words a shop can read',
    /already being made/i.test(again.refused[0]?.why ?? ''), again.refused[0]?.why);
  const count = await prisma.photoJob.count({ where: { productId: product.id, colourName: 'Firebrick' } });
  check('exactly one job exists for that colour', count === 1, String(count));

  console.log('\nD. PRESSING IT AGAIN AFTER THE FIRST ONE FINISHED');
  await prisma.photoJob.updateMany({
    where: { productId: product.id, colourName: 'Firebrick' }, data: { status: 'DONE' }
  });
  const third = await queue('Firebrick');
  check('a finished job does not block the next one', third.made.length === 1, JSON.stringify(third.refused));
  await prisma.photoJob.updateMany({
    where: { productId: product.id, colourName: 'Firebrick' }, data: { status: 'DONE' }
  });

  console.log('\nE. THE PHOTOGRAPH IT WAS MADE FROM HAS BEEN DELETED');
  await prisma.productImage.deleteMany({
    where: { productId: product.id, slot: 'saree', variant: { colorName: 'Firebrick' } }
  });
  const r5 = await queue('Firebrick');
  check('it still queues rather than failing', r5.made.length === 1, JSON.stringify(r5.refused));
  const j5: any = await jobFor('Firebrick');
  check('falling back to the front view it has',
    j5.sourceImageUrl === IMG('Firebrick-front'), j5.sourceImageUrl);
  check('and the blouse, which is still there, still goes with it',
    j5.referenceUrls?.blouse === IMG('Firebrick-blouse'), JSON.stringify(j5.referenceUrls));

  console.log('\nF. A COLOUR WITH NOTHING LEFT AT ALL');
  const bare = await prisma.productVariant.create({
    data: {
      productId: product.id, clientId: CLIENT, colorName: 'Bare', size: 'Free',
      variantCode: 'V-Bare', sku: 'S-Bare', sellingPrice: 5000 as any
    }
  });
  void bare;
  const r6 = await queue('Bare');
  check('it is refused, not crashed', r6.made.length === 0 && r6.refused.length === 1, JSON.stringify(r6));
  check('and told what to do about it',
    /photograph/i.test(r6.refused[0]?.why ?? ''), r6.refused[0]?.why);

  console.log('\nG. A COLOUR THAT IS NOT ON THIS PRODUCT');
  const r7 = await queue('Chartreuse');
  check('asking for a colour that does not exist is refused',
    r7.made.length === 0 && r7.refused.length === 1, JSON.stringify(r7));

  console.log('\nH. ANOTHER SHOP\'S PRODUCT');
  const stranger = await photoJobQueue.enqueue({
    clientId: 'someone-else', productId: product.id, kind: 'VIEWS', colours: ['Firebrick']
  } as any).catch((e: any) => ({ made: [], refused: [{ colour: 'x', why: e?.message ?? 'refused' }] }));
  check('cannot be made to work on somebody else\'s garment',
    (stranger as any).made.length === 0, JSON.stringify((stranger as any).made?.length));

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
