/**
 * Try-on failures are kept with the REAL reason (Platform Console → Errors → Try-on).
 *
 * Real failures that cost nothing: a throwaway shop is given a deliberately wrong key, so the real
 * gateway refuses it -- no generation runs, no allowance is spent. The four-view job is run as an
 * unsaved row, so no worker anywhere can pick it up.
 *
 *   A  a customer try-on the gateway refuses: real status and words, where, what the shopper saw
 *   B  a four-view job over its allowance: recorded as LIMIT
 *   C  a four-view job the studio refuses: real status and words, job and product
 *   D  the console list: filters, last-24h counts, top reasons, and the outage warning at 5+ in an hour
 *   E  recording never throws, whatever it is handed
 *
 *   npx tsx src/scripts/verify-tryon-failures.ts
 */
import { prisma } from '../lib/prisma';
import { encryptCredential } from '../lib/credentialEncryption';
import { shopperTryOnGatewayService } from '../services/shopper-tryon/gateway.service';
import { PhotoJobRunner } from '../services/photo-jobs';
import { listTryOnFailures, recordTryOnFailure } from '../services/tryon';

const T = `tryon-fail-${Date.now()}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};
const settle = () => new Promise(r => setTimeout(r, 2500));   // recording is fire-and-forget
const mine = () => prisma.tryOnFailure.findMany({ where: { clientId: T }, orderBy: { createdAt: 'asc' } });
const junkKey = (service: 'SHOPPER_TRYON' | 'CATALOG_TRYON') => prisma.clientServiceCredential.create({
  data: { clientId: T, service, keyEncrypted: encryptCredential(`sk_test_definitely_not_a_real_key_${service}`), keyPrefix: 'sk_test_d', addedByAdmin: 'verify-tryon-failures', status: 'ACTIVE' } as any
});

async function main() {
  console.log('\nA. CUSTOMER TRY-ON THE GATEWAY REFUSES');
  await junkKey('SHOPPER_TRYON');
  const err = await shopperTryOnGatewayService.generate({
    clientId: T, garmentImageUrl: 'https://example.com/garment.jpg', humanImageUrl: 'https://example.com/person.jpg', place: 'COUNTER'
  }).then(() => null, e => e);
  check('the shopper still gets only the friendly sentence', /could not complete this request|took too long/.test(err?.message ?? ''), err?.message);
  await settle();
  let rows = await mine();
  const a = rows.find(r => r.service === 'SHOPPER_TRYON');
  check('...and the failure is kept: Customer try-on, at the Counter', !!a && a.place === 'COUNTER', a);
  check('...with the gateway\'s real HTTP status (a refusal, not "502")', !!a?.httpStatus && a.httpStatus >= 400 && a.httpStatus < 500, a?.httpStatus);
  check('...the gateway\'s own words, not ours', !!a && a.error.length > 0 && !/could not complete this request/.test(a.error), a?.error);
  check('...and what the shopper was told, side by side', a?.shownMessage === 'The try-on service could not complete this request.', a?.shownMessage);

  console.log('\nB. A FOUR-VIEW JOB OVER ITS ALLOWANCE');
  await prisma.clientServiceLimit.create({ data: { clientId: T, service: 'CATALOG_TRYON', monthlyLimit: 0, updatedByAdmin: 'verify-tryon-failures' } as any });
  const job: any = {
    id: `job-${Date.now()}`, clientId: T, productId: 'product-not-real', kind: 'VIEWS', status: 'RUNNING', colourName: 'Red', colourKey: 'red',
    colourHex: null, variantIds: [], sourceImageId: null, sourceImageUrl: 'https://example.com/flatlay.jpg', referenceUrls: null,
    jobKey: 'views-Red', category: 'SAREE', modelId: 'saree1', viewsDone: 0, viewsTotal: 4, message: null, requestedBy: null,
    cancelRequested: false, attempts: 1, heartbeatAt: null, startedAt: new Date(), finishedAt: null, seenAt: null, createdAt: new Date(), updatedAt: new Date()
  };
  await PhotoJobRunner.runJob(job);
  await settle();
  rows = await mine();
  const b = rows.find(r => r.code === 'LIMIT');
  check('recorded as LIMIT, Four-view photos, Photo job, with the job and product', !!b && b.service === 'CATALOG_TRYON' && b.place === 'PHOTO_JOB' && b.jobId === job.id && b.productId === 'product-not-real', b);
  check('...with the real words ("used its 0 …")', /used its 0/.test(b?.error ?? ''), b?.error);

  console.log('\nC. A FOUR-VIEW JOB THE STUDIO REFUSES');
  await prisma.clientServiceLimit.deleteMany({ where: { clientId: T } });
  await junkKey('CATALOG_TRYON');
  await PhotoJobRunner.runJob({ ...job, id: `${job.id}-2`, attempts: 2 });
  await settle();
  rows = await mine();
  const c = rows.find(r => r.jobId === `${job.id}-2`);
  check('recorded with what happened at the far end (refused, or an error we could not get past)', !!c && ['STUDIO_REFUSED', 'EXCEPTION', 'STUDIO_ERROR'].includes(c.code ?? ''), c);
  check('...with the attempt number', c?.attempt === 2, c?.attempt);
  check('...and the shop was told a friendly sentence, not the far end\'s words', !!c?.shownMessage && c.shownMessage !== c.error, { shown: c?.shownMessage, error: c?.error });

  console.log('\nD. THE CONSOLE LIST');
  for (let i = 0; i < 5; i++) recordTryOnFailure({ clientId: T, service: 'SHOPPER_TRYON', place: 'SHOP_PAGE', httpStatus: 429, code: 'STUDIO_REFUSED', error: `RESOURCE_EXHAUSTED: monthly spending cap reached (request ${i}0042)` });
  await settle();
  const list = await listTryOnFailures({ clientId: T, days: 1 });
  check('the shop filter shows only this shop\'s failures', list.rows.length >= 8 && list.rows.every(r => r.clientId === T), list.rows.length);
  check('newest first', list.rows.every((r, i) => i === 0 || list.rows[i - 1].createdAt >= r.createdAt));
  const shopper = await listTryOnFailures({ clientId: T, service: 'SHOPPER_TRYON', days: 1 });
  check('the service filter keeps only Customer try-on', shopper.rows.length >= 6 && shopper.rows.every(r => r.service === 'SHOPPER_TRYON'), shopper.rows.length);
  check('five-plus failures in the last hour raise the outage warning', !!list.outage && list.outage.failures >= 5, list.outage);
  const top = list.lastDay.topReasons[0];
  check('the same reason with different request numbers groups as one top reason', !!top && /429/.test(top.reason) && top.count >= 5, list.lastDay.topReasons);

  console.log('\nD2. COLOUR PHOTOS ARE NAMED AS SUCH, AND THE MENU CAN ASK FOR ONE ROW');
  // A real job row so the list can look its kind up. FAILED, so no worker anywhere will claim it.
  // productId must be a real product; the demo help-shop lends one. The job stays under the
  // throwaway shop id, so no shop's screen lists it, and it is deleted at the end.
  const lent = await prisma.product.findFirst({ where: { clientId: 'lakshmi-silks-demo-helpshop-1791264977589' }, select: { id: true } });
  const colourJob = await prisma.photoJob.create({ data: { ...job, productId: lent!.id, id: undefined, kind: 'COLOUR', status: 'FAILED', jobKey: 'colour-Red', createdAt: undefined, updatedAt: undefined } as any });
  recordTryOnFailure({ clientId: T, service: 'CATALOG_TRYON', place: 'PHOTO_JOB', code: 'STUDIO_ERROR', error: 'colour run failed', jobId: colourJob.id });
  await settle();
  const withKind = await listTryOnFailures({ clientId: T, days: 1 });
  check('a failed colour job comes back as jobKind COLOUR', withKind.rows.find(r => r.jobId === colourJob.id)?.jobKind === 'COLOUR', withKind.rows.find(r => r.jobId === colourJob.id));
  check('...and a failure whose job was never saved has jobKind null, not an error', withKind.rows.filter(r => r.jobId && r.jobId !== colourJob.id).every(r => r.jobKind === null));
  const one = await listTryOnFailures({ clientId: T, days: 1, limit: 1 });
  check('limit 1 returns one row, and the outage still counts every failure', one.rows.length === 1 && (one.outage?.failures ?? 0) >= 5, { rows: one.rows.length, outage: one.outage });
  const bad = await listTryOnFailures({ clientId: T, days: 1, limit: -5 });
  check('a negative limit is treated as at least one row, newest first', bad.rows.length >= 1 && bad.rows[0].createdAt >= bad.rows[bad.rows.length - 1].createdAt, bad.rows.length);

  console.log('\nE. RECORDING NEVER THROWS');
  const circular: any = {}; circular.self = circular;
  let threw = false;
  try { recordTryOnFailure({ clientId: T, service: 'CATALOG_TRYON', place: 'CATALOG_STREAM', error: circular }); } catch { threw = true; }
  try { recordTryOnFailure({ clientId: T, service: 'CATALOG_TRYON', place: 'CATALOG_STREAM', error: 'x'.repeat(10000) }); } catch { threw = true; }
  check('a circular object or a 10,000-character error is recorded without throwing', !threw);
  await settle();
  const long = (await mine()).find(r => r.place === 'CATALOG_STREAM' && r.error.startsWith('xxxx'));
  check('...a long error is trimmed to 4,000 characters', long?.error.length === 4000, long?.error.length);
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  await prisma.tryOnFailure.deleteMany({ where: { clientId: T } });
  await prisma.photoJob.deleteMany({ where: { clientId: T } }).catch(() => {});
  await prisma.clientServiceCredential.deleteMany({ where: { clientId: T } });
  await prisma.clientServiceLimit.deleteMany({ where: { clientId: T } });
  await prisma.tryOnUsage.deleteMany({ where: { clientId: T } }).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
