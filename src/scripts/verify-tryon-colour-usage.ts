/**
 * Catalog try-on usage split into four-view catalogs and colour variants (owner, 28 Oct).
 *
 *   1. record() keeps the totals as totals and counts colour runs a second time in their own
 *      columns; summary() and daily() hand back catalogs / colourVariants / notCharged exactly.
 *   2. The two REAL recording paths say which kind a run was: the photo-job worker (kind COLOUR
 *      vs VIEWS) and the direct generate-catalog route (a `color` in the body). Only the upstream
 *      stream and the picture upload are stood in for -- nothing paid is called.
 *   3. The console endpoint over HTTP: the split, and the money line read from a LOCAL Gateway
 *      stub with the shop's own key (on / not deployed / broken), the shared-key sentence, the
 *      5-minute cache, and the key never in the response.
 *
 * LOCAL DATABASE ONLY. Needs the local server on 4016 started with
 *   CATALOG_TRYON_GATEWAY_URL=http://localhost:4099  CATALOG_TRYON_API_KEY=<any dummy>
 *
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory npx tsx src/scripts/verify-tryon-colour-usage.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || process.env.DATABASE_URL).includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL/DIRECT_URL must point at the local copy (${LOCAL}).`);
  process.exit(2);
}

import { EventEmitter } from 'node:events';
import { prisma } from '../lib/prisma';
import { tryOnUsageService, catalogTryOnService } from '../services/tryon';
import { imageService } from '../services/image.service';
import { PhotoJobRunner } from '../services/photo-jobs/runner';
import { CatalogTryOnController } from '../controllers/catalog-tryon.controller';
import { AuthService } from '../services/auth.service';
import { startGatewayUsageStub } from './gateway-usage-stub';

const API = process.env.API_URL || 'http://localhost:4016/api/v1';
const STAMP = Date.now();
const clients: string[] = [];
const fresh = (tag: string) => { const c = `colour-usage-${tag}-${STAMP}`; clients.push(c); return c; };

let pass = 0, fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail !== undefined ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

/** record() is fire-and-forget on the real paths; wait until the row shows what we expect. */
async function settle(clientId: string, until: (s: any) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  let s: any;
  while (Date.now() < end) {
    s = await tryOnUsageService.summary(clientId);
    if (until(s)) return s;
    await new Promise(r => setTimeout(r, 150));
  }
  return s;
}

/** An SSE body like the catalog service's: VIEW_READY per view, then COMPLETE or an ERROR. */
function sse(frames: object[]): Response {
  const text = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('');
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const views = (n: number) => ['FRONT', 'BACK', 'LEFT', 'RIGHT'].slice(0, n).map(v => ({ type: 'VIEW_READY', view: v, image: TINY_JPEG }));

async function serviceLevel() {
  console.log('\n1. RECORD AND SUMMARY: TOTALS STAY TOTALS, COLOUR COUNTED BESIDE THEM');
  const c = fresh('svc');
  // 3 four-view catalogs (4, 4, 3 views), 2 colour variants (4, 4), 1 colour failed, 1 colour
  // cancelled, 1 four-view failed, 1 four-view cancelled.
  for (const v of [4, 4, 3]) await tryOnUsageService.record(c, { started: true, completed: true, viewsGenerated: v });
  for (const v of [4, 4]) await tryOnUsageService.record(c, { started: true, completed: true, viewsGenerated: v, colour: true });
  await tryOnUsageService.record(c, { started: true, failed: true, colour: true });
  await tryOnUsageService.record(c, { started: true, cancelled: true, colour: true });
  await tryOnUsageService.record(c, { started: true, failed: true });
  await tryOnUsageService.record(c, { started: true, cancelled: true });

  const s = await tryOnUsageService.summary(c);
  eq('completed is still every completed run (3 + 2)', s.completed, 5);
  eq('failed is still every failure (1 + 1)', s.failed, 2);
  eq('cancelled is still every cancellation (1 + 1)', s.cancelled, 2);
  eq('views are still all views (4+4+3+4+4)', s.viewsGenerated, 19);
  eq('generations against the allowance unchanged: completed + failed', s.generations, 7);
  eq('four-view catalogs = 5 - 2', (s as any).catalogs, 3);
  eq('colour variants = 2', (s as any).colourVariants, 2);
  eq('colour failed = 1, colour cancelled = 1', [(s as any).colourFailed, (s as any).colourCancelled], [1, 1]);
  eq('not charged = failed + cancelled = 4', (s as any).notCharged, 4);

  const row = await prisma.tryOnUsage.findFirst({ where: { clientId: c } });
  eq('the day row holds colour_started 4 (2 done + 1 failed + 1 cancelled)', (row as any)?.colourStarted, 4);
  eq("...and started 9 in total (3 + 2 + 4 others)", row?.started, 9);

  const d = await tryOnUsageService.daily(c, 30);
  eq('daily() gives one day with the same split', d.map((x: any) => [x.completed, x.catalogs, x.colourVariants, x.colourFailed, x.colourCancelled]), [[5, 3, 2, 1, 1]]);

  console.log('\n   A shop with no colour runs and an old-style row reads catalogs = completed');
  const old = fresh('old');
  await tryOnUsageService.record(old, { started: true, completed: true, viewsGenerated: 4 });
  const o = await tryOnUsageService.summary(old);
  eq('catalogs 1, colour 0, not charged 0', [(o as any).catalogs, (o as any).colourVariants, (o as any).notCharged], [1, 0, 0]);

  console.log('\n   The shopper service is untouched by the split');
  await tryOnUsageService.record(old, { started: true, completed: true }, 'SHOPPER_TRYON');
  const sh = await tryOnUsageService.summary(old, undefined, 'SHOPPER_TRYON');
  eq('shopper completed 1, catalogs 1 colour 0 there too', [sh.completed, (sh as any).catalogs, (sh as any).colourVariants], [1, 1, 0]);
  const cat = await tryOnUsageService.summary(old);
  eq('...and the catalog month did not move', [cat.completed, (cat as any).catalogs], [1, 1]);
}

async function realPaths() {
  console.log('\n2. THE REAL PATHS RECORD THE KIND (upstream stream and picture upload stood in)');
  const c = fresh('paths');
  const product = await prisma.product.create({
    data: {
      clientId: c, productCode: `CU-${STAMP}`, slug: `cu-${STAMP}`, title: `Colour usage test ${STAMP}`,
      category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', fabric: 'Silk',
      basePrice: 1000, status: 'ACTIVE' as any, hsnCode: '5007', taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false
    } as any
  });
  const variant = async (colour: string) => (await prisma.productVariant.create({
    data: { productId: product.id, clientId: c, colorName: colour, size: 'Free Size', variantCode: `CUV-${colour}-${STAMP}`, sku: `CUS-${colour}-${STAMP}`, sellingPrice: 1000 } as any
  })).id;

  // Only these two are replaced, and only for this run: the stream from the far end and the
  // upload of the picture bytes. Counting, the job row, the image rows are all the real code.
  const realStream = catalogTryOnService.streamGenerateCatalog.bind(catalogTryOnService);
  const realStore = imageService.storeBytes.bind(imageService);
  const sent: any[] = [];
  let next: () => Response = () => sse([]);
  (catalogTryOnService as any).streamGenerateCatalog = async (body: any) => { sent.push(body); return next(); };
  (imageService as any).storeBytes = async (_p: string, _c: string, fileName: string, bytes: Buffer) => ({
    publicUrl: `https://local.invalid/${STAMP}/${Math.random().toString(36).slice(2)}/${fileName}`,
    storagePath: `${c}/${product.id}/${fileName}`, fileName, fileSize: bytes.length
  });

  try {
    const job = async (kind: 'VIEWS' | 'COLOUR', colour: string, stream: () => Response) => {
      next = stream;
      const v = await variant(colour);
      const row = await prisma.photoJob.create({
        data: {
          clientId: c, productId: product.id, kind, status: 'RUNNING', colourName: colour, colourKey: colour.toLowerCase(),
          colourHex: kind === 'COLOUR' ? '#AA0000' : null, variantIds: [v], sourceImageUrl: 'https://local.invalid/source.jpg',
          jobKey: `${kind.toLowerCase()}-${colour}`, category: 'SAREE', modelId: 'saree1', attempts: 1
        } as any
      });
      await PhotoJobRunner.runJob(row as any);
      return prisma.photoJob.findUnique({ where: { id: row.id }, select: { status: true, viewsDone: true } });
    };

    const a = await job('VIEWS', 'Green', () => sse([...views(4), { type: 'COMPLETE' }]));
    eq('a VIEWS job with four views finishes DONE', a, { status: 'DONE', viewsDone: 4 });
    const b = await job('COLOUR', 'Red', () => sse([...views(4), { type: 'COMPLETE' }]));
    eq('a COLOUR job with four views finishes DONE', b, { status: 'DONE', viewsDone: 4 });
    eq('...and the far end was asked for that colour', sent[sent.length - 1]?.color, { name: 'Red', hex: '#aa0000' });
    const d = await job('COLOUR', 'Blue', () => sse([...views(3), { type: 'COMPLETE' }]));
    eq('a COLOUR job that got three of four finishes DONE (completed, as any run would be)', d, { status: 'DONE', viewsDone: 3 });
    const e = await job('COLOUR', 'Pink', () => sse([{ type: 'ERROR', error: 'boom' }]));
    eq('a COLOUR job that broke finishes FAILED', e?.status, 'FAILED');
    const f = await job('VIEWS', 'Gold', () => new Response('nope', { status: 500 }));
    eq('a VIEWS job the far end refused finishes FAILED', f?.status, 'FAILED');

    const s = await settle(c, x => x.completed + x.failed >= 5);
    eq('photo jobs: completed 3, failed 2', [s.completed, s.failed], [3, 2]);
    eq('photo jobs: catalogs 1 (Green), colour variants 2 (Red, Blue)', [s.catalogs, s.colourVariants], [1, 2]);
    eq('photo jobs: colour failed 1 (Pink), not charged 2', [s.colourFailed, s.notCharged], [1, 2]);
    eq('photo jobs: views 4 + 4 + 3', s.viewsGenerated, 11);

    console.log('\n   The direct generate-catalog route');
    const controller = new CatalogTryOnController();
    const call = async (body: any, stream: () => Response) => {
      next = stream;
      const res: any = Object.assign(new EventEmitter(), {
        writableFinished: false, statusCode: 200, chunks: [] as string[],
        status(n: number) { this.statusCode = n; return this; },
        setHeader() {}, flushHeaders() {}, write(ch: string) { this.chunks.push(ch); return true; },
        end() { this.writableFinished = true; this.emit('close'); }, json(b: any) { this.body = b; this.end(); }
      });
      let nextErr: any = null;
      await controller.generateCatalog({ clientId: c, body } as any, res, (err: any) => { nextErr = err; });
      return { res, nextErr };
    };
    await call({ modelId: 'saree1', category: 'SAREE', saree: 'https://local.invalid/s.jpg' }, () => sse([...views(4), { type: 'COMPLETE' }]));
    await call({ modelId: 'saree1', category: 'SAREE', saree: 'https://local.invalid/s.jpg', color: { name: 'Maroon', hex: '#800000' } }, () => sse([...views(4), { type: 'COMPLETE' }]));
    await call({ modelId: 'saree1', category: 'SAREE', saree: 'https://local.invalid/s.jpg', color: 'Teal' }, () => sse([{ type: 'ERROR', error: { code: 'CANCELLED' }, code: 'CANCELLED' }]));
    await call({ modelId: 'saree1', category: 'SAREE', saree: 'https://local.invalid/s.jpg', color: { name: '', hex: '' } }, () => sse([...views(2), { type: 'COMPLETE' }]));

    const t = await settle(c, x => x.completed + x.failed + x.cancelled >= 9);
    eq('direct: completed 3 + 3 = 6 (plain, Maroon, empty colour)', t.completed, 6);
    eq('direct: catalogs 1 + 2 = 3 (an empty colour is not a colour)', t.catalogs, 3);
    eq('direct: colour variants 2 + 1 = 3 (Maroon)', t.colourVariants, 3);
    eq('direct: the Teal run cancelled, counted as a colour cancellation', [t.cancelled, t.colourCancelled], [1, 1]);
    eq('direct: not charged = 2 failed + 1 cancelled', t.notCharged, 3);
  } finally {
    (catalogTryOnService as any).streamGenerateCatalog = realStream;
    (imageService as any).storeBytes = realStore;
    await prisma.productImage.deleteMany({ where: { productId: product.id } });
    await prisma.photoJob.deleteMany({ where: { clientId: c } });
    await prisma.productVariant.deleteMany({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });
  }
}

async function overHttp() {
  console.log('\n3. THE CONSOLE ENDPOINT, WITH A LOCAL GATEWAY STUB ON 4099');
  const health = await fetch(API.replace(/\/api\/v1$/, '') + '/health').then(r => r.ok, () => false);
  if (!health) { check('the local server on 4016 is up', false, API); return; }

  const stub = await startGatewayUsageStub(4099);
  try {
    const admin = await prisma.platformAdmin.findFirst({ where: { status: 'ACTIVE' }, select: { id: true, sessionVersion: true } });
    if (!admin) { check('a local platform admin exists', false); return; }
    const cookie = `platform_admin_token=${AuthService.generatePlatformAdminToken({ platformAdminId: admin.id, sessionVersion: admin.sessionVersion })}`;
    const get = async (clientId: string) => {
      const r = await fetch(`${API}/admin/clients/${clientId}/tryon-usage?service=CATALOG_TRYON`, { headers: { cookie } });
      const text = await r.text();
      return { status: r.status, text, body: JSON.parse(text) };
    };
    const addKey = (clientId: string, key: string) => fetch(`${API}/admin/clients/${clientId}/service-keys`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost:5183' },
      body: JSON.stringify({ service: 'CATALOG_TRYON', key })
    }).then(r => r.status);

    // Shared key: counts only, and the sentence.
    const shared = fresh('shared');
    await tryOnUsageService.record(shared, { started: true, completed: true, viewsGenerated: 4 });
    await tryOnUsageService.record(shared, { started: true, completed: true, viewsGenerated: 4, colour: true });
    await tryOnUsageService.record(shared, { started: true, failed: true, colour: true });
    const a = await get(shared);
    eq('shared key: 200', a.status, 200);
    eq('shared key: catalogs 1, colour 1, not charged 1', [a.body.data.summary.catalogs, a.body.data.summary.colourVariants, a.body.data.summary.notCharged], [1, 1, 1]);
    eq('shared key: charges say SHARED_KEY (no Gateway call)', a.body.data.charges, { state: 'SHARED_KEY' });
    eq('daily over HTTP carries the split', a.body.data.daily.map((d: any) => [d.catalogs, d.colourVariants]), [[1, 1]]);

    // Own key, billing on.
    const on = fresh('on');
    const onKey = `sek_test_on_${STAMP}_abcdef`;
    eq('own key saved through the console (checked against the stub)', await addKey(on, onKey), 200);
    const b = await get(on);
    eq('own key + billing on: total and GST from the Gateway, in paise',
      b.body.data.charges, { state: 'ON', month: b.body.data.summary.month, totalPaise: 123310, gstPaise: 18810, gstRatePercent: 18 });
    check('the key never appears in the response', !b.text.includes(onKey) && !b.text.includes('abcdef'));
    eq('the Gateway was asked once', stub.hits[onKey], 1);
    await get(on); await get(on);
    eq('...and not again within 5 minutes (cached)', stub.hits[onKey], 1);

    // Own key, billing not deployed (404), and a broken Gateway (500 HTML).
    const off = fresh('off');
    eq('own key (billing off) saved', await addKey(off, `sek_test_off_${STAMP}`), 200);
    const c = await get(off);
    eq('own key + Gateway 404: one plain state, not an error', [c.status, c.body.data.charges], [200, { state: 'NOT_ON' }]);
    const bad = fresh('bad');
    eq('own key (broken gateway) saved', await addKey(bad, `sek_test_bad_${STAMP}`), 200);
    const d = await get(bad);
    eq('own key + Gateway 500 garbage: the same plain state', [d.status, d.body.data.charges], [200, { state: 'NOT_ON' }]);

    // The shopper service carries no money line.
    const sh = await fetch(`${API}/admin/clients/${on}/tryon-usage?service=SHOPPER_TRYON`, { headers: { cookie } }).then(r => r.json());
    eq('shopper usage: charges null', sh.data.charges, null);

    // The shop's own view gets the same split (needs a shop user in the local DB).
    const owner = await prisma.user.findFirst({ where: { clientId: 'verify-suites-tenant', status: 'ACTIVE' }, select: { id: true, sessionVersion: true } });
    if (owner) {
      const own = 'verify-suites-tenant';
      // Snapshot the shop's catalog rows and put them back EXACTLY afterwards (an earlier
      // decrement-based undo drove its colour counters negative when run on the old code).
      const saved = await prisma.tryOnUsage.findMany({ where: { clientId: own, service: 'CATALOG_TRYON' } });
      try {
        const before = await tryOnUsageService.summary(own);
        await tryOnUsageService.record(own, { started: true, completed: true, viewsGenerated: 4, colour: true });
        const token = AuthService.generateToken({ userId: owner.id, clientId: own, sessionVersion: owner.sessionVersion });
        const r = await fetch(`${API}/services/tryon-usage?service=CATALOG_TRYON`, { headers: { cookie: `token=${token}` } }).then(x => x.json());
        eq('shop route: colour variants went up by exactly 1', r.data.colourVariants - (before as any).colourVariants, 1);
        eq('shop route: catalogs unchanged', r.data.catalogs, (before as any).catalogs);
        check('shop route: carries no charges at all', !('charges' in r.data));
      } finally {
        await prisma.tryOnUsage.deleteMany({ where: { clientId: own, service: 'CATALOG_TRYON' } });
        for (const row of saved) await prisma.tryOnUsage.create({ data: row });
      }
    } else {
      check('a local shop user exists for the shop route', false);
    }
  } finally {
    await stub.close();
  }
}

(async () => {
  try {
    await serviceLevel();
    await realPaths();
    await overHttp();
  } catch (e) {
    fail++; failures.push(`crashed: ${(e as any)?.message}`);
    console.error(e);
  } finally {
    await prisma.tryOnUsage.deleteMany({ where: { clientId: { in: clients } } });
    await prisma.clientServiceCredential.deleteMany({ where: { clientId: { in: clients } } });
    await prisma.tryOnFailure.deleteMany({ where: { clientId: { in: clients } } });
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED: ' + failures.join(' | '));
  process.exit(fail ? 1 : 0);
})();
