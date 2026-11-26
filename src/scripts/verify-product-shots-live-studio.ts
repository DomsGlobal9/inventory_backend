/**
 * Product photos only, through the REAL worker and the REAL photo studio (26 Nov 2026). Free: the studio does not charge
 * product-shots-only runs (catalog c1650d0). LOCAL database, a throwaway shop; the pictures are sphl's public live photos
 * of one saree. The one thing replaced is the final upload (local storage is switched off on purpose): pictures are
 * written to a local folder instead. Everything else -- the queue, the request the worker builds, the stream, the
 * saving of rows, the wording -- is the real code.
 *   1. a saree with its main photo, one extra photo of the SAME saree, its blouse and its old front view:
 *      3 product photos saved as the colour's pictures after the views, none primary, job DONE;
 *   2. an extra photo of a DIFFERENT saree: refused by the studio before anything is made; the job FAILED with our
 *      words naming the photo, and no picture saved.
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-product-shots-live-studio.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { imageService } from '../services/image.service';
import { photoJobQueue, PhotoJobRunner } from '../services/photo-jobs';
import { makeThrowawayShop } from './lib/throwaway-shop';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
// The real studio (this machine's backend/.env); the local launch config points it at a dead address on purpose.
const dotenv = Object.fromEntries(fs.readFileSync(path.join(__dirname, '../../.env'), 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m![1], m![2].replace(/^["']|["']$/g, '')]));

const OUT = 'D:/downloads/catalog-shots-test/worker';
fs.mkdirSync(OUT, { recursive: true });
(imageService as any).storeBytes = async (productId: string, clientId: string, fileName: string, bytes: Buffer) => {
  const file = path.join(OUT, `${Date.now()}-${fileName}`);
  fs.writeFileSync(file, bytes);
  // The same path shape real storage gives (clientId/productId/...), which saving the row checks.
  return { publicUrl: `file:///${file.replace(/\\/g, '/')}`, storagePath: `${clientId}/${productId}/${path.basename(file)}`, fileName, fileSize: bytes.length };
};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};

const SPHL = 'https://izrzvdejtfhpzrxzkasu.supabase.co/storage/v1/object/public/inventory-images/sphl';
const BANARASI = `${SPHL}/0d0e9231-1517-4ed2-8094-e5d82230cac4`;
const OTHER_SAREE = `${SPHL}/b4e3970f-1e5f-4641-b886-911115a916e7/1790593605782_front.jpg`;

async function main() {
  const { env } = await import('../config/env');
  (env as any).CATALOG_TRYON_GATEWAY_URL = dotenv.CATALOG_TRYON_GATEWAY_URL;
  (env as any).CATALOG_TRYON_API_KEY = dotenv.CATALOG_TRYON_API_KEY;
  if (!/^https:/.test(String(env.CATALOG_TRYON_GATEWAY_URL))) { console.error('No real studio address in backend/.env'); process.exit(2); }

  const t = await makeThrowawayShop('ShotsStudio');
  const { clientId } = t;
  try {
    const product = await prisma.product.create({ data: { clientId, productCode: `SHOT-${Date.now()}`, slug: `shot-${Date.now()}`, title: 'Banarasi tissue saree (test)', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any } as any });
    const v = await prisma.productVariant.create({ data: { clientId, productId: product.id, colorName: 'Lime Green', size: 'Free', variantCode: `SHV-${Date.now()}`, sku: `SHS-${Date.now()}` } as any });
    const img = (url: string, extra: any) => prisma.productImage.create({ data: { productId: product.id, variantId: v.id, url, imageType: 'GALLERY', orderIndex: 0, ...extra } as any });
    await img(`${BANARASI}/1792655186747_1-saree.jpg`, { generated: false, slot: 'saree', isPrimary: false });
    const folded = await img(`${BANARASI}/1792655193862_3-folded.jpg`, { generated: false });
    await img(`${BANARASI}/1792655191385_2-blouse.jpg`, { generated: false, slot: 'blouse' });
    await img(`${BANARASI}/1792656390633_front.jpg`, { generated: true, view: 'front', isPrimary: true });

    // 1. The same saree.
    const q = await photoJobQueue.enqueue({ clientId, productId: product.id, kind: 'SHOTS', colours: ['Lime Green'] });
    ok('queued: product photos only, with the extra photo and the old front view', q.made.length === 1 && q.made[0].extraSourceImageIds?.includes(folded.id) && !!q.made[0].frontViewUrl, q);
    const t0 = Date.now();
    await PhotoJobRunner.runJob(q.made[0]);
    const job = await prisma.photoJob.findUniqueOrThrow({ where: { id: q.made[0].id } });
    console.log(`  ran in ${Math.round((Date.now() - t0) / 1000)} s: ${job.status}${job.message ? ` -- "${job.message}"` : ''}`);
    ok('the job is DONE with 3 product photos', job.status === 'DONE' && job.shotsDone === 3, { status: job.status, shotsDone: job.shotsDone, message: job.message });
    const shots = await prisma.productImage.findMany({ where: { productId: product.id, generated: true, view: { in: ['closeup', 'folded', 'table'] } }, orderBy: { orderIndex: 'asc' } });
    ok('3 pictures saved for the colour: close-up, folded, table', JSON.stringify(shots.map(s => s.view)) === JSON.stringify(['closeup', 'folded', 'table']), shots.map(s => s.view));
    ok('...after the views (order 3, 4, 5), none the main photo', shots.every((s, i) => s.orderIndex === 3 + i && !s.isPrimary), shots.map(s => [s.orderIndex, s.isPrimary]));
    ok('...named for the shop ("Lime Green, fabric close-up")', shots[0]?.altText === 'Lime Green, fabric close-up', shots[0]?.altText);
    const front = await prisma.productImage.findFirst({ where: { productId: product.id, generated: true, view: 'front' } });
    ok('the old front view is untouched and still the main photo', !!front?.isPrimary);

    // 2. A different saree as the extra.
    await prisma.productImage.update({ where: { id: folded.id }, data: { url: OTHER_SAREE } });
    const q2 = await photoJobQueue.enqueue({ clientId, productId: product.id, kind: 'SHOTS', colours: ['Lime Green'] });
    const before = await prisma.productImage.count({ where: { productId: product.id } });
    await PhotoJobRunner.runJob(q2.made[0]);
    const job2 = await prisma.photoJob.findUniqueOrThrow({ where: { id: q2.made[0].id } });
    console.log(`  different saree: ${job2.status} -- "${job2.message}"`);
    ok('a different saree as the extra: FAILED, in our words naming the photo', job2.status === 'FAILED' && /Extra photo 1 shows a different saree/.test(job2.message ?? ''), job2.message);
    ok('...nothing saved, nothing replaced', (await prisma.productImage.count({ where: { productId: product.id } })) === before);
  } finally {
    await t.remove();
  }
  console.log(`\n${pass} passed, ${fail} failed   (pictures in ${OUT})`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
