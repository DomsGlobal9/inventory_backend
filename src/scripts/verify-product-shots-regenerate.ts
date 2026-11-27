/**
 * Product shots made again: never duplicates, always a fresh set (27 Nov 2026, owner's question).
 *
 * The real queue and the real job runner on a throwaway saree; only the far-end studio is a stand-in (no paid run),
 * and picture storage is a local stand-in (no test picture reaches real storage).
 *
 *   1  a saree with NO product shots: "make product photos" -> exactly 3 (close-up, folded, table), none leading
 *   2  made again -> still exactly 3, all NEW pictures (the old 3 gone), the 3 model views untouched
 *   3  the full three-view set made again (it brings shots too) -> 3 views + 3 shots, no doubles of either
 *   4  a second "make" while one is already queued for that colour is refused in words (no double job)
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-product-shots-regenerate.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { passed++; console.log(`PASS ${name}`); } else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 300)}`}`); }
};

// Local picture storage: upload, public read, delete. Enough for storeBytes / deleteImage.
const files = new Map<string, Buffer>();
const storage = http.createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on('data', c => parts.push(c));
  req.on('end', () => {
    const url = decodeURIComponent(String(req.url).split('?')[0]);
    const send = (s: number, j: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    let m: RegExpMatchArray | null;
    if ((req.method === 'POST' || req.method === 'PUT') && (m = url.match(/^\/storage\/v1\/object\/(.+)$/))) { files.set(m[1], Buffer.concat(parts)); return send(200, { Key: m[1] }); }
    if (req.method === 'DELETE' && (m = url.match(/^\/storage\/v1\/object\/([^/]+)$/))) {
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}');
      for (const p of body.prefixes ?? []) files.delete(`${m[1]}/${p}`);
      return send(200, (body.prefixes ?? []).map((name: string) => ({ name })));
    }
    if (req.method === 'GET' && (m = url.match(/^\/storage\/v1\/object\/public\/(.+)$/))) {
      const f = files.get(m[1]); if (!f) return send(404, { message: 'not found' });
      res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(f);
    }
    send(404, { message: `not in the stand-in: ${req.method} ${url}` });
  });
});

(async () => {
  for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
  await new Promise<void>(r => storage.listen(0, '127.0.0.1', () => r()));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'standin-key-local-only-0001';
  process.env.CATALOG_TRYON_GATEWAY_URL = 'http://127.0.0.1:9';   // never the real studio, even by mistake

  const { prisma } = await import('../lib/prisma');
  const { makeThrowawayShop, removeShop } = await import('./lib/throwaway-shop');
  const { photoJobQueue, PhotoJobRunner } = await import('../services/photo-jobs');
  const { catalogTryOnService } = await import('../services/tryon');

  // The studio stand-in: answers a job with SSE frames -- 3 views (unless shots only) and the 3 product shots.
  const pic = async (hex: string) => `data:image/jpeg;base64,${(await sharp({ create: { width: 64, height: 96, channels: 3, background: hex } }).jpeg().toBuffer()).toString('base64')}`;
  let calls = 0;
  (catalogTryOnService as any).streamGenerateCatalog = async (body: any) => {
    calls++;
    const frames: string[] = [];
    if (!body.productShotsOnly) for (const v of ['front', 'side', 'sitting']) frames.push(JSON.stringify({ type: 'VIEW_READY', view: v, image: await pic('#336699') }));
    for (const s of ['closeup', 'folded', 'table']) frames.push(JSON.stringify({ type: 'PRODUCT_SHOT', shot: s, image: await pic('#2e7d32'), checkPassed: true }));
    frames.push(JSON.stringify({ type: 'COMPLETE' }));
    return new Response(frames.map(f => `data: ${f}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const t = await makeThrowawayShop('Shots');
  const C = t.clientId;
  try {
    const S = Date.now().toString(36);
    const p = await prisma.product.create({ data: { clientId: C, productCode: `SH-${S}`, slug: `sh-${S}`, title: 'Kanchi saree (shots test)', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any } as any });
    const v = await prisma.productVariant.create({ data: { clientId: C, productId: p.id, colorName: 'Teal', size: 'Free', variantCode: `SHV-${S}`, sku: `SHS-${S}` } as any });
    const own = await prisma.productImage.create({ data: { productId: p.id, variantId: v.id, url: 'https://example.invalid/own.jpg', imageType: 'GALLERY', orderIndex: 0, generated: false, isPrimary: true, fileName: 'teal.jpg' } as any });
    const VIEWS = ['front', 'left', 'right'];   // ours; the studio says front, sitting, side
    for (const view of VIEWS) await prisma.productImage.create({ data: { productId: p.id, variantId: v.id, url: `https://example.invalid/${view}.jpg`, imageType: 'GALLERY', orderIndex: 1, generated: true, view, isPrimary: false, generatedFromId: own.id } as any });

    const shots = () => prisma.productImage.findMany({ where: { productId: p.id, generated: true, view: { in: ['closeup', 'folded', 'table'] } }, select: { id: true, view: true, isPrimary: true } });
    const views = () => prisma.productImage.findMany({ where: { productId: p.id, generated: true, view: { in: VIEWS } }, select: { id: true, view: true } });
    const run = async (kind: 'SHOTS' | 'VIEWS') => {
      const q = await photoJobQueue.enqueue({ clientId: C, productId: p.id, kind, colours: ['Teal'] } as any);
      if (!q.made.length) throw new Error(`not queued: ${JSON.stringify(q.refused)}`);
      const job = await prisma.photoJob.findUniqueOrThrow({ where: { id: q.made[0].id } });
      await prisma.photoJob.update({ where: { id: job.id }, data: { status: 'RUNNING', startedAt: new Date(), attempts: 1 } });
      await PhotoJobRunner.runJob(await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } }));
      return prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    };

    ok('before: the saree has its 3 model views and NO product shots', (await views()).length === 3 && (await shots()).length === 0);

    const j1 = await run('SHOTS');
    const s1 = await shots();
    ok('1  "make product photos": exactly 3 (close-up, folded, table)', s1.length === 3 && new Set(s1.map(x => x.view)).size === 3, s1.map(x => x.view));
    ok('   ...none of them becomes the main photo', s1.every(x => !x.isPrimary));
    ok('   ...the job finished DONE', j1.status === 'DONE', { status: j1.status, message: j1.message });

    const views1 = (await views()).map(x => x.id).sort().join();
    const j2 = await run('SHOTS');
    const s2 = await shots();
    ok('2  made again: still exactly 3 product shots, no duplicates', s2.length === 3 && new Set(s2.map(x => x.view)).size === 3, s2.map(x => x.view));
    ok('   ...all 3 are NEW pictures (the old 3 removed)', s2.every(x => !s1.some(o => o.id === x.id)), { before: s1.map(x => x.id), after: s2.map(x => x.id) });
    ok('   ...the model views were not touched', (await views()).map(x => x.id).sort().join() === views1);
    ok('   ...DONE', j2.status === 'DONE', { status: j2.status, message: j2.message });

    const j3 = await run('VIEWS');
    const s3 = await shots(), v3 = await views();
    ok('3  the whole set made again: 3 views + 3 shots, no doubles of either', s3.length === 3 && v3.length === 3 && new Set(v3.map(x => x.view)).size === 3, { shots: s3.map(x => x.view), views: v3.map(x => x.view) });
    ok('   ...the shots are new again', s3.every(x => !s2.some(o => o.id === x.id)));
    ok('   ...and the 3 views are new too (the old ones removed, not kept beside them)', v3.every(x => !(views1.split(',')).includes(x.id)));
    ok('   ...DONE', j3.status === 'DONE', { status: j3.status, message: j3.message });

    const first = await photoJobQueue.enqueue({ clientId: C, productId: p.id, kind: 'SHOTS', colours: ['Teal'] } as any);
    const second = await photoJobQueue.enqueue({ clientId: C, productId: p.id, kind: 'SHOTS', colours: ['Teal'] } as any);
    ok('4  a second "make" while one is queued for that colour: refused in words, no double job', first.made.length === 1 && second.made.length === 0 && /already being made/i.test(second.refused?.[0]?.why ?? ''), second.refused);
    await prisma.photoJob.updateMany({ where: { clientId: C, status: 'QUEUED' }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    ok('the studio stand-in was asked exactly 3 times (one per run, nothing twice)', calls === 3, calls);
  } catch (e) {
    console.error(e); failed++;
  } finally {
    await removeShop(C).catch(e => console.log('left the throwaway shop', e?.message));
    await prisma.$disconnect();
    storage.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
