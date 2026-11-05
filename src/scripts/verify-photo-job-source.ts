/**
 * Choosing which photograph a set of views is made from. Over real HTTP on the local server (4016), which has
 * background jobs off: jobs are created and checked, none is ever run, so no AI is paid for.
 * LOCAL DATABASE ONLY, shop verify-suites-tenant. Removes what it made.
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 400)}`}`); }
};
const C = 'verify-suites-tenant', STAMP = String(Date.now()).slice(-6);
const API = 'http://localhost:4016/api/v1';
const PIC = 'https://example.com/test-photo.jpg';

async function main() {
  const health = await fetch('http://localhost:4016/health').then(r => r.json()).catch(() => null) as any;
  check('the local server answers, on the local database', health?.database === 'local', health);
  if (health?.database !== 'local') return;
  const owner = await prisma.user.findFirstOrThrow({ where: { clientId: C, email: 'verify-suites@example.com' } });
  const token = AuthService.generateToken({ userId: owner.id, clientId: C, sessionVersion: owner.sessionVersion });
  const post = (body: unknown, as = token) => fetch(`${API}/photo-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5183', cookie: `token=${as}` }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));

  const product = await prisma.product.create({ data: { clientId: C, productCode: `PJ${STAMP}`, slug: `pj${STAMP}`, title: `Photo choice ${STAMP}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any } as any });
  const variant = (colorName: string) => prisma.productVariant.create({ data: { productId: product.id, clientId: C, colorName, size: 'Free', variantCode: `PJ${STAMP}-${colorName}`, sku: `PJ${STAMP}-${colorName}`, sellingPrice: 1000 } as any });
  const red = await variant('Red'), blue = await variant('Blue'), green = await variant('Green');
  const image = (variantId: string, extra: any = {}) => prisma.productImage.create({ data: { productId: product.id, variantId, url: PIC, imageType: 'GALLERY', ...extra } as any });
  const redMain = await image(red.id, { isPrimary: true }), redOther = await image(red.id), redBlouse = await image(red.id, { slot: 'blouse' }), redTop = await image(red.id, { slot: 'top' });
  const bluePhoto = await image(blue.id);
  const greenBlouse = await image(green.id, { slot: 'blouse' }), greenSaree = await image(green.id, { slot: 'saree' }), greenOther = await image(green.id, { isPrimary: true });
  const clear = () => prisma.photoJob.deleteMany({ where: { productId: product.id } });
  const jobOf = (colour: string) => prisma.photoJob.findFirst({ where: { productId: product.id, colourName: colour } });
  const views = (colours: string[], sourceImageId?: string) => post({ productId: product.id, kind: 'VIEWS', colours, ...(sourceImageId ? { sourceImageId } : {}) });

  try {
    let r = await views(['Red'], redOther.id);
    check('a photo the shop chose is the one the job uses', r.status === 200 && (await jobOf('Red'))?.sourceImageId === redOther.id, r);
    check('...the job waits, and nothing runs it here', (await jobOf('Red'))?.status === 'QUEUED' && (await jobOf('Red'))?.viewsDone === 0);
    await clear();

    r = await views(['Red']);
    check('none chosen: the main photo, as before', r.status === 200 && (await jobOf('Red'))?.sourceImageId === redMain.id, r);
    await clear();
    r = await views(['Green']);
    check('none chosen: the one marked as the saree beats the main photo', r.status === 200 && (await jobOf('Green'))?.sourceImageId === greenSaree.id, r);
    await clear();
    r = await views(['Green'], greenOther.id);
    check('...but the shop\'s choice beats that too', (await jobOf('Green'))?.sourceImageId === greenOther.id, r);
    const refs = (await jobOf('Green'))?.referenceUrls as any;
    check('...and the blouse still goes along as the blouse', refs?.blouse === greenBlouse.url, refs);
    await clear();

    r = await views(['Red'], bluePhoto.id);
    check('a photo of another colour is refused, in words', r.status === 200 && r.body?.data?.made?.length === 0 && /another colour/.test(r.body?.data?.refused?.[0]?.why ?? ''), r);
    check('...and no job is made', !(await jobOf('Red')));
    r = await views(['Red'], redBlouse.id);
    check('a blouse piece is refused as the garment', r.body?.data?.made?.length === 0 && /one piece/.test(r.body?.data?.refused?.[0]?.why ?? ''), r);
    r = await views(['Red'], redTop.id);
    check('...and so is a top', r.body?.data?.made?.length === 0 && /one piece/.test(r.body?.data?.refused?.[0]?.why ?? ''), r);
    check('...no job from either', !(await jobOf('Red')));

    const other = await prisma.productImage.findFirst({ where: { product: { clientId: { not: C } } }, select: { id: true } });
    if (other) {
      r = await views(['Red'], other.id);
      check('another shop\'s photo is refused', r.status === 400 && !(await jobOf('Red')), r);
    }
    r = await views(['Red'], '00000000-0000-0000-0000-000000000000');
    check('a made-up photo is refused', r.status === 400, r);

    // The flat-lay path that was already there must still work: uploaded for this colour, then sent by id.
    const flat = await image(blue.id, { imageType: 'RAW_UPLOAD' });
    r = await views(['Blue'], flat.id);
    check('a flat-lay just uploaded for this colour still works', (await jobOf('Blue'))?.sourceImageId === flat.id, r);
    await clear();

    // A photo with no colour on it belongs to the whole product.
    const general = await prisma.productImage.create({ data: { productId: product.id, url: PIC, imageType: 'GALLERY' } as any });
    r = await views(['Red'], general.id);
    check('a photo of the whole product can be used', (await jobOf('Red'))?.sourceImageId === general.id, r);
    await clear();

    // Asked for twice: the same colour is refused, not made twice.
    await views(['Red'], redOther.id);
    r = await views(['Red'], redMain.id);
    check('the same colour while one is waiting: refused, one job only', r.body?.data?.made?.length === 0 && await prisma.photoJob.count({ where: { productId: product.id, colourName: 'Red', status: { in: ['QUEUED', 'RUNNING'] } } }) === 1, r);
    check('...still from the first photo chosen', (await jobOf('Red'))?.sourceImageId === redOther.id);
  } finally {
    await clear();
    await prisma.productImage.deleteMany({ where: { productId: product.id } });
    await prisma.productVariant.deleteMany({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });
    check('nothing left behind', await prisma.product.count({ where: { productCode: `PJ${STAMP}`, clientId: C } }) === 0);
  }
}

main()
  .catch(e => { failed++; failures.push(`stopped: ${e?.message ?? e}`); console.log(`  FAIL stopped: ${e?.stack ?? e}`); })
  .finally(async () => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log(failures.map(f => ` - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
