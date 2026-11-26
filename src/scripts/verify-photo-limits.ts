/**
 * Photo limits, every case (26 Nov 2026, owner: "limits added in the Platform Console should act from here and from
 * there"). LOCAL database, a throwaway shop. The gateway is a stand-in on this machine answering exactly as
 * api-super-admin does (its codes, statuses and bodies, read from its source): the queue, the worker and the wording are
 * the real code.
 *   AT THE PRESS     monthly limit reached (usage says so)          -> refused at once, nothing queued
 *                    usage cannot be read (gateway old / down)      -> not a reason to refuse
 *                    Inventory's own allowance used up               -> refused (product photos only are not counted)
 *   WHEN IT RUNS     402 MONTHLY_LIMIT_REACHED                       -> FAILED in plain words; the shop's other waiting
 *                                                                       jobs stopped with the same sentence; not counted
 *                    403 suspended / 401 expired key                 -> FAILED, its own sentence; the rest stopped
 *                    429 daily (retryAfterSec)                       -> waits and tries again by itself; not an attempt
 *                    503 busy                                        -> waits ~2 min
 *                    a waiting job is not started before its time
 *   MANY AT ONCE     the bulk press with the limit reached           -> one message, the loop stops
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-photo-limits.ts
 */
import http from 'node:http';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { photoJobQueue, PhotoJobRunner } from '../services/photo-jobs';
import { forgetCatalogLimit } from '../services/tryon';
import { makeThrowawayShop } from './lib/throwaway-shop';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}

// The stand-in gateway: what /api/v1/usage and generate-catalog answer is set per case.
let usageAnswer: { status: number; body: any } = { status: 200, body: { monthlyLimit: null } };
let generateAnswer: { status: number; body: any } = { status: 200, body: null };
let generateCalls = 0;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/v1/usage')) { res.writeHead(usageAnswer.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(usageAnswer.body)); return; }
  if (req.url?.includes('/draping/generate-catalog')) {
    generateCalls++;
    res.writeHead(generateAnswer.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(generateAnswer.body)); return;
  }
  res.writeHead(404); res.end();
});

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const plain = (m: string | null | undefined) => !!m && !/HTTP|API key|retryAfter|[A-Z]{2,}_[A-Z]|\bundefined\b|\{|\}/.test(m);
const errOf = async (f: () => Promise<unknown>) => { try { await f(); return null; } catch (e: any) { return e; } };

async function main() {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  (env as any).CATALOG_TRYON_GATEWAY_URL = `http://127.0.0.1:${port}/api/gateway/cat`;
  (env as any).CATALOG_TRYON_API_KEY = 'stand-in-key-for-this-test-only';
  process.env.CATALOG_TRYON_API_KEY = 'stand-in-key-for-this-test-only';

  const t = await makeThrowawayShop('PhotoLimits');
  const { clientId } = t;
  try {
    const product = await prisma.product.create({ data: { clientId, productCode: `LIM-${Date.now()}`, slug: `lim-${Date.now()}`, title: 'Limit test saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any } as any });
    const colours = ['Red', 'Blue', 'Green', 'Gold'];
    for (const c of colours) {
      const v = await prisma.productVariant.create({ data: { clientId, productId: product.id, colorName: c, size: 'Free', variantCode: `LIM-${c}-${Date.now()}`, sku: `LIMS-${c}-${Date.now()}` } as any });
      await prisma.productImage.create({ data: { productId: product.id, variantId: v.id, url: `https://example.invalid/${c}.jpg`, imageType: 'GALLERY', generated: false, slot: 'saree' } as any });
    }
    const clear = () => prisma.photoJob.deleteMany({ where: { clientId } });
    const jobsNow = () => prisma.photoJob.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } });

    // ── At the press ──────────────────────────────────────────────────────────────────────────
    console.log('AT THE PRESS');
    usageAnswer = { status: 200, body: { monthlyLimit: { reached: true, limit: { rupees: '5000.00' }, used: { rupees: '5012.00' }, remaining: { rupees: '0.00' } } } };
    forgetCatalogLimit();
    const e1 = await errOf(() => photoJobQueue.enqueue({ clientId, productId: product.id, kind: 'VIEWS', colours: ['Red'] }));
    ok("monthly limit reached: refused at the press, 402, in plain words", e1?.statusCode === 402 && /This month's photo limit is used up/.test(e1?.message) && plain(e1?.message), e1);
    ok('...nothing queued, the gateway never asked to generate', (await jobsNow()).length === 0 && generateCalls === 0);
    const e1s = await errOf(() => photoJobQueue.enqueue({ clientId, productId: product.id, kind: 'SHOTS', colours: ['Red'] }));
    ok('...product photos only are refused too (the gateway refuses them at the same address)', e1s?.statusCode === 402);

    usageAnswer = { status: 500, body: { error: { code: 'INTERNAL_ERROR' } } };
    forgetCatalogLimit();
    const q1 = await photoJobQueue.enqueue({ clientId, productId: product.id, kind: 'VIEWS', colours: ['Red'] });
    ok('usage cannot be read: not a reason to refuse (queued)', q1.made.length === 1, q1);
    await clear();

    usageAnswer = { status: 200, body: { monthlyLimit: { reached: false, limit: { rupees: '5000.00' }, used: { rupees: '120.00' }, remaining: { rupees: '4880.00' } } } };
    forgetCatalogLimit();

    // Inventory's own allowance (its console's limit for this shop): a three-view run is refused at the press,
    // product photos only are not counted, so they still start.
    await prisma.clientServiceLimit.upsert({ where: { uq_client_service_limit: { clientId, service: 'CATALOG_TRYON' } } as any, create: { clientId, service: 'CATALOG_TRYON', monthlyLimit: 0, updatedByAdmin: 'verify-photo-limits' } as any, update: { monthlyLimit: 0 } });
    const e2 = await errOf(() => photoJobQueue.enqueue({ clientId, productId: product.id, kind: 'VIEWS', colours: ['Red'] }));
    ok("Inventory's own allowance used up: refused at the press, in plain words", e2?.statusCode === 429 && /used its|allowance/i.test(e2?.message) && plain(e2?.message), e2);
    const s2 = await photoJobQueue.enqueue({ clientId, productId: product.id, kind: 'SHOTS', colours: ['Red'] });
    ok('...product photos only still start (they are not counted)', s2.made.length === 1, s2);
    await prisma.clientServiceLimit.deleteMany({ where: { clientId } });
    await clear();

    // ── When it runs ──────────────────────────────────────────────────────────────────────────
    console.log('');
    console.log('WHEN IT RUNS');
    const run = async (answer: { status: number; body: any }, colourList: string[]) => {
      await clear();
      const q = await photoJobQueue.enqueue({ clientId, productId: product.id, kind: 'VIEWS', colours: colourList });
      generateAnswer = answer;
      const first = await prisma.photoJob.findUniqueOrThrow({ where: { id: q.made[0].id } });
      await PhotoJobRunner.runJob(first);
      return jobsNow();
    };
    const usageBefore = await prisma.tryOnUsage.aggregate({ where: { clientId }, _sum: { started: true, failed: true } }).catch(() => null);

    let jobs = await run({ status: 402, body: { error: { code: 'MONTHLY_LIMIT_REACHED', message: "This month's limit is reached. Ask ScaleEzy to raise it." } } }, colours);
    ok('402 monthly limit: the job FAILED, in plain words', jobs[0].status === 'FAILED' && /This month's photo limit is used up/.test(jobs[0].message ?? '') && plain(jobs[0].message), jobs[0].message);
    ok("...the shop's 3 other waiting jobs stopped with the same sentence (one notice, not one per job)",
      jobs.slice(1).every(j => j.status === 'FAILED' && j.message === `Not started. ${jobs[0].message}`), jobs.map(j => [j.status, j.message]));
    const usageAfter = await prisma.tryOnUsage.aggregate({ where: { clientId }, _sum: { started: true, failed: true } }).catch(() => null);
    ok('...nothing counted against the shop (a refusal made nothing)', JSON.stringify(usageAfter?._sum) === JSON.stringify(usageBefore?._sum), [usageBefore?._sum, usageAfter?._sum]);

    jobs = await run({ status: 403, body: { error: { code: 'ACCESS_DENIED', message: 'Client account is suspended or disabled' } } }, ['Red', 'Blue']);
    ok('403 suspended: "paused for this shop", the rest stopped', /paused for this shop/.test(jobs[0].message ?? '') && jobs[1].status === 'FAILED', jobs.map(j => j.message));
    jobs = await run({ status: 401, body: { error: { code: 'UNAUTHORIZED_API_KEY', message: 'API Key has expired' } } }, ['Red']);
    ok("401 expired key: \"this shop's photo key has expired\"", /photo key has expired/.test(jobs[0].message ?? '') && plain(jobs[0].message), jobs[0].message);

    jobs = await run({ status: 429, body: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Daily request limit of 50 exceeded for cat' }, retryAfterSec: 3600 } }, ['Red', 'Blue']);
    const waiting = jobs[0];
    const mins = waiting.notBefore ? Math.round((waiting.notBefore.getTime() - Date.now()) / 60000) : null;
    ok('429 daily limit: the job WAITS (queued again), about an hour, not failed', waiting.status === 'QUEUED' && mins !== null && mins >= 55 && mins <= 61, { status: waiting.status, mins });
    ok("...says so: \"Today's limit ... tries again by itself at <time>\"", /Today's limit for making photos is reached\. It tries again by itself at/.test(waiting.message ?? ''), waiting.message);
    ok('...the wait is not counted as an attempt', waiting.attempts === 0, waiting.attempts);
    ok('...the other waiting job is left in line (a daily limit passes)', jobs[1].status === 'QUEUED');
    const claimed = await PhotoJobRunner.claimNext();
    ok('...a job is not started before its time (the other one may be)', !claimed || claimed.id !== waiting.id, claimed?.id);
    if (claimed) await prisma.photoJob.update({ where: { id: claimed.id }, data: { status: 'QUEUED', startedAt: null } });

    jobs = await run({ status: 503, body: { error: { code: 'SERVICE_BUSY', message: 'Maximum concurrent requests reached for cat' } } }, ['Red']);
    const busyMins = jobs[0].notBefore ? Math.round((jobs[0].notBefore.getTime() - Date.now()) / 60000) : null;
    ok('503 busy: waits about 2 minutes, "busy just now"', jobs[0].status === 'QUEUED' && busyMins !== null && busyMins >= 1 && busyMins <= 3 && /busy just now/.test(jobs[0].message ?? ''), { status: jobs[0].status, busyMins, m: jobs[0].message });

    // A kind this code does not know is never claimed (the switch-over lesson, 26 Nov 2026).
    await clear();
    const unknownKind = await prisma.photoJob.create({ data: { clientId, productId: product.id, kind: 'FUTURE_KIND', status: 'QUEUED', colourName: 'Red', colourKey: 'red', variantIds: [], sourceImageUrl: 'https://example.invalid/x.jpg', jobKey: 'future-red', category: 'SAREE', modelId: 'saree1' } as any });
    const grabbed = await PhotoJobRunner.claimNext();
    ok('a job kind this code does not know is never claimed', !grabbed || grabbed.id !== unknownKind.id, grabbed?.kind);
    if (grabbed && grabbed.id !== unknownKind.id) await prisma.photoJob.update({ where: { id: grabbed.id }, data: { status: 'QUEUED' } });
    await clear();

    // ── Many at once ──────────────────────────────────────────────────────────────────────────
    console.log('');
    console.log('MANY AT ONCE');
    await clear();
    usageAnswer = { status: 200, body: { monthlyLimit: { reached: true, limit: { rupees: '5000.00' }, used: { rupees: '5000.00' }, remaining: { rupees: '0.00' } } } };
    forgetCatalogLimit();
    const { photoJobsController } = await import('../controllers/photo-jobs.controller');
    const bulk: any = await new Promise(resolve => {
      const res: any = { status(c: number) { this.code = c; return this; }, json(b: any) { resolve({ status: this.code ?? 200, body: b }); } };
      void photoJobsController.productShots({ clientId, user: { id: null }, body: { productIds: [product.id, product.id + 'x'] } } as any, res, (e: any) => resolve({ status: 500, body: String(e?.message ?? e) }));
    });
    ok('bulk with the limit reached: one message, the press stops, nothing queued',
      bulk.status === 200 && /This month's photo limit is used up/.test(bulk.body?.data?.stopped ?? '') && (await jobsNow()).length === 0, bulk.body);
  } finally {
    await prisma.photoJob.deleteMany({ where: { clientId } }).catch(() => undefined);
    await t.remove();
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); server.close(); await prisma.$disconnect(); process.exit(1); });
