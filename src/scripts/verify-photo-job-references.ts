/**
 * Everything the shop photographed reaches the photo studio, and the right piece leads.
 *
 * The photos step asks a saree shop for the drape AND the blouse piece, and a two-piece shop for
 * the full dress, the top and the bottom. The job used to send ONE image. So every extra
 * photograph the shop was asked for was uploaded, stored and never used -- the model was dressed
 * in whatever happened to be draped in that one picture.
 *
 * And which piece a photograph WAS got thrown away at upload, so the source fell through to "the
 * primary, or else the first". A shop that uploaded the blouse before the drape had the blouse
 * sent AS the saree. Nothing failed; the pictures were simply of the wrong thing. That is why
 * the checks below care about ORDER of upload, which looks irrelevant until you know.
 *
 *   npx tsx src/scripts/verify-photo-job-references.ts
 */
import { prisma } from '../lib/prisma';
import { photoJobQueue } from '../services/photo-jobs/queue';

const CLIENT = `refs-${Date.now()}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

const url = (s: string) => `https://example.com/${s}.jpg`;

/** A product with one colour, photographed into the given slots IN THE GIVEN ORDER. */
async function makeProduct(code: string, dressType: string, slots: Array<[string | null, string]>) {
  const product = await prisma.product.create({
    data: {
      clientId: CLIENT, productCode: code, slug: code.toLowerCase(), title: `Ref ${code}`,
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType,
      basePrice: 5000 as any, status: 'ACTIVE' as any, publishedAt: new Date()
    }
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id, clientId: CLIENT, colorName: 'Gold', size: 'Free',
      variantCode: `${code}-V`, sku: `${code}-S`, sellingPrice: 5000 as any
    }
  });
  for (let i = 0; i < slots.length; i++) {
    const [slot, name] = slots[i];
    await prisma.productImage.create({
      data: {
        productId: product.id, variantId: variant.id, imageType: 'GALLERY' as any,
        orderIndex: i, url: url(name), isPrimary: i === 0, slot
      }
    });
  }
  return product;
}

async function queueViews(productId: string) {
  const { made, refused } = await photoJobQueue.enqueue({
    clientId: CLIENT, productId, kind: 'VIEWS', colours: ['Gold']
  } as any);
  if (!made.length) throw new Error(`nothing queued: ${JSON.stringify(refused)}`);
  return prisma.photoJob.findUnique({
    where: { id: made[0].id },
    select: { sourceImageUrl: true, referenceUrls: true, kind: true }
  });
}

async function main() {
  const location = await prisma.stockLocation.create({
    data: { clientId: CLIENT, name: 'Counter', code: `RF-${Date.now() % 100000}`, type: 'STORE' as any, active: true }
  });
  void location;

  console.log('\nA. A SAREE GOES WITH ITS BLOUSE');
  const saree = await makeProduct('REF-SAREE', 'Saree', [['saree', 'drape'], ['blouse', 'choli']]);
  const j1: any = await queueViews(saree.id);
  check('the drape is what the model wears', j1.sourceImageUrl === url('drape'), j1.sourceImageUrl);
  check('and the blouse piece is sent with it', j1.referenceUrls?.blouse === url('choli'),
    JSON.stringify(j1.referenceUrls));
  check('nothing else is invented', Object.keys(j1.referenceUrls ?? {}).join() === 'blouse',
    JSON.stringify(Object.keys(j1.referenceUrls ?? {})));

  console.log('\nB. AND THE ORDER THEY WERE UPLOADED IN DOES NOT DECIDE IT');
  /*
   * The blouse first, which is the case that used to send a blouse piece as a saree: it was
   * uploaded first, so it was isPrimary, so it was "the primary, or else the first".
   */
  const backwards = await makeProduct('REF-BACKWARDS', 'Saree', [['blouse', 'choli2'], ['saree', 'drape2']]);
  const j2: any = await queueViews(backwards.id);
  check('uploading the blouse first still sends the DRAPE as the garment',
    j2.sourceImageUrl === url('drape2'), j2.sourceImageUrl);
  check('and the blouse as the blouse', j2.referenceUrls?.blouse === url('choli2'),
    JSON.stringify(j2.referenceUrls));

  console.log('\nC. A TWO-PIECE OUTFIT SENDS ALL THREE');
  const suit = await makeProduct('REF-SUIT', 'Lehenga', [
    ['full-dress', 'whole'], ['top', 'kurta'], ['bottom', 'salwar']
  ]);
  const j3: any = await queueViews(suit.id);
  check('the full dress is the garment', j3.sourceImageUrl === url('whole'), j3.sourceImageUrl);
  check('the top is sent', j3.referenceUrls?.top === url('kurta'), JSON.stringify(j3.referenceUrls));
  check('and the bottom is sent', j3.referenceUrls?.bottom === url('salwar'), JSON.stringify(j3.referenceUrls));
  check('all three pieces reach the far end, which is the whole point',
    !!j3.sourceImageUrl && !!j3.referenceUrls?.top && !!j3.referenceUrls?.bottom);

  console.log('\nD. THE OTHER SLOT NAME THE FORM USES');
  // The wizard's own empty map calls it top-front while its fields call it top. Both mean the
  // garment's top half, and the far end has one field for it.
  const alt = await makeProduct('REF-ALT', 'Anarkalis', [
    ['full-dress', 'whole2'], ['top-front', 'kurta2'], ['bottom', 'salwar2']
  ]);
  const j4: any = await queueViews(alt.id);
  check('top-front counts as the top', j4.referenceUrls?.top === url('kurta2'), JSON.stringify(j4.referenceUrls));

  console.log('\nE. A SHOP THAT PHOTOGRAPHED ONLY THE GARMENT');
  const bare = await makeProduct('REF-BARE', 'Saree', [['saree', 'only']]);
  const j5: any = await queueViews(bare.id);
  check('still queues', j5.sourceImageUrl === url('only'), j5.sourceImageUrl);
  check('and sends no empty references, because absent and blank are different answers',
    j5.referenceUrls === null || Object.keys(j5.referenceUrls ?? {}).length === 0,
    JSON.stringify(j5.referenceUrls));

  console.log('\nF. PHOTOGRAPHS TAKEN BEFORE ANY OF THIS EXISTED');
  // Every photograph already in the database has no slot. Those products must keep working
  // exactly as they did, on the old "primary, or else first" rule.
  const legacy = await makeProduct('REF-LEGACY', 'Saree', [[null, 'old1'], [null, 'old2']]);
  const j6: any = await queueViews(legacy.id);
  check('an unslotted product still uses its primary photograph',
    j6.sourceImageUrl === url('old1'), j6.sourceImageUrl);
  check('and sends no references it cannot identify',
    j6.referenceUrls === null || Object.keys(j6.referenceUrls ?? {}).length === 0,
    JSON.stringify(j6.referenceUrls));

  console.log('\nG. A RECOLOUR IS NOT A PHOTOSHOOT');
  /*
   * A COLOUR job copies an already-finished front view and recolours the cloth in it. The blouse
   * in that picture is the one the shop already approved; handing the far end a flat blouse piece
   * again would invite it to redraw what is already right.
   */
  const second = await prisma.productVariant.create({
    data: {
      productId: saree.id, clientId: CLIENT, colorName: 'Ruby', size: 'Free',
      variantCode: 'REF-SAREE-V2', sku: 'REF-SAREE-S2', sellingPrice: 5000 as any
    }
  });
  const goldVariant = await prisma.productVariant.findFirst({
    where: { productId: saree.id, colorName: 'Gold' }, select: { id: true }
  });
  await prisma.productImage.create({
    data: {
      productId: saree.id, variantId: goldVariant!.id, imageType: 'GALLERY' as any,
      orderIndex: 9, url: url('front-view'), generated: true, view: 'front'
    }
  });
  void second;
  const { made } = await photoJobQueue.enqueue({
    clientId: CLIENT, productId: saree.id, kind: 'COLOUR', colours: ['Ruby']
  } as any);
  const j7: any = made.length
    ? await prisma.photoJob.findUnique({ where: { id: made[0].id }, select: { sourceImageUrl: true, referenceUrls: true } })
    : null;
  check('a colour job copies the finished front view', j7?.sourceImageUrl === url('front-view'), String(j7?.sourceImageUrl));
  check('and carries no separate pieces, because they are already in that picture',
    j7 !== null && (j7.referenceUrls === null || Object.keys(j7.referenceUrls ?? {}).length === 0),
    JSON.stringify(j7?.referenceUrls));

  console.log(`\nRESULT: ${passed} passed | ${failed} failed`);

  const w = { clientId: CLIENT };
  await prisma.photoJob.deleteMany({ where: w }).catch(() => {});
  await prisma.productImage.deleteMany({ where: { product: w } }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: w }).catch(() => {});
  await prisma.product.deleteMany({ where: w }).catch(() => {});
  await prisma.stockLocation.deleteMany({ where: w }).catch(() => {});
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
  await prisma.stockLocation.deleteMany({ where: w }).catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
