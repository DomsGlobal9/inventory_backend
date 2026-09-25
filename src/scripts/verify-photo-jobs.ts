/**
 * Photographs get made even when nobody is watching.
 *
 * The thing this replaces ran entirely in a browser tab: the page held the stream open AND did
 * the saving, so closing the tab threw the work away after the GPU time had been paid for. The
 * rules below are the ones that make the server-side version safe to leave alone, and every one
 * of them is a case that either cost money or lost work.
 *
 * It does NOT generate anything. Every check here is about the queue, the claim, the recovery,
 * the refusals and which picture a job works from -- running a real generation to prove those
 * would spend a shop's paid allowance on bookkeeping. The generation itself is tested through
 * the UI, against the test tenant, once.
 *
 * It builds everything it needs and deletes it again. The first version leaned on whatever
 * sarees happened to exist on a shop, which meant a check quietly went missing the day one of
 * them had no photograph -- and a skipped check reads exactly like a passing one in a wall of
 * green. It also meant a suite about photographs was poking at a demo shop somebody uses.
 *
 * Run it with the worker STOPPED, or it will claim these rows and generate them for real:
 *
 *   npx ts-node src/scripts/verify-photo-jobs.ts
 */
import { prisma } from '../lib/prisma';
import { photoJobQueue } from '../services/photo-jobs';
import { PhotoJobRunner, MAX_ATTEMPTS } from '../services/photo-jobs';

/**
 * Whichever shop this machine's worker is allowed to work for.
 *
 * It has to match, or every claim check fails for the right reason and looks like the wrong one:
 * PhotoJobRunner reads PHOTO_JOBS_ONLY_CLIENTS at import and will not touch a shop outside it.
 */
const SHOP = (process.env.PHOTO_JOBS_ONLY_CLIENTS || '').split(',')[0].trim() || 'verify-suites-tenant';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const madeProducts = new Set<string>();
const madeJobs = new Set<string>();

function remember<T extends { made: any[] }>(result: T): T {
  for (const j of result.made) madeJobs.add(j.id);
  return result;
}

/** Nothing live, so the queue cap and the claim checks each start from a known place. */
async function clearLive() {
  await prisma.photoJob.updateMany({
    where: { clientId: SHOP, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'DONE', finishedAt: new Date() }
  });
}

let stamp = Date.now();
async function makeProduct(title: string, dressType: string | null) {
  stamp++;
  const p = await prisma.product.create({
    data: {
      clientId: SHOP, productCode: `VERIFY-PJ-${stamp}`, slug: `verify-pj-${stamp}`,
      title, category: 'WOMEN', productType: 'READY_TO_WEAR', dressType, basePrice: 1
    }
  });
  madeProducts.add(p.id);
  return p;
}

let variantNo = 0;
async function makeColour(
  productId: string,
  name: string,
  opts: { own?: boolean; ownIsPrimary?: boolean; views?: string[] } = {}
) {
  variantNo++;
  const v = await prisma.productVariant.create({
    data: {
      productId, clientId: SHOP, colorName: name, size: 'Free',
      variantCode: `VPJ${variantNo}`, sku: `VPJ-${Date.now()}-${variantNo}`
    }
  });

  const image = (extra: any) => prisma.productImage.create({
    data: {
      productId, variantId: v.id, url: 'https://example.invalid/x.jpg',
      imageType: 'GALLERY', orderIndex: 0, ...extra
    }
  });

  const own = opts.own
    ? await image({ generated: false, isPrimary: opts.ownIsPrimary ?? false, fileName: `${name}.jpg` })
    : null;
  const views: Record<string, any> = {};
  for (const view of opts.views ?? []) {
    views[view] = await image({ generated: true, view, isPrimary: view === 'front' });
  }
  return { variant: v, own, views };
}

async function main() {
  console.log(`PHOTO JOBS  (shop: ${SHOP})\n`);
  await clearLive();

  /*
   * One product carrying every shape a colour can be in. Named so a failure says which case
   * broke without anybody having to go and read the fixture.
   */
  const product = await makeProduct('Verify photo jobs (delete me)', 'Saree');
  const maroon = await makeColour(product.id, 'Maroon', { own: true, ownIsPrimary: true });
  await makeColour(product.id, 'Red');                                  // nothing at all
  const amber = await makeColour(product.id, 'Amber', { own: true, views: ['front', 'left'] });
  const teal = await makeColour(product.id, 'Teal', { views: ['front'] });   // stopped, nothing of its own
  const olive = await makeColour(product.id, 'Olive', { own: true, views: ['front', 'left', 'right', 'back'] });
  await makeColour(product.id, 'Plum');                                 // nothing, to be copied into

  // ── Starting one ────────────────────────────────────────────────────────────────────────────
  console.log('STARTING ONE');

  const first = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: ['Maroon']
  }));
  check('a colour with a photograph can be queued', first.made.length === 1, JSON.stringify(first.refused));
  check('it starts QUEUED, with nothing done and nothing spent',
    first.made[0]?.status === 'QUEUED' && first.made[0]?.viewsDone === 0);
  check('the source photograph is recorded on the row, not worked out later',
    first.made[0]?.sourceImageId === maroon.own!.id);
  check('the model is chosen once and kept, so a retry matches the views already saved',
    /^saree[1-4]$/.test(first.made[0]?.modelId ?? ''), first.made[0]?.modelId);
  check('it targets every size of the colour, not just one',
    (first.made[0]?.variantIds ?? []).length === 1);

  // ── Two people, one colour ──────────────────────────────────────────────────────────────────
  console.log('\nTWO PEOPLE, ONE COLOUR');

  const again = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: ['Maroon']
  }));
  check('the same colour cannot be queued twice', again.made.length === 0 && again.refused.length === 1);
  check('and it says so in words a shop can read',
    /already being made/i.test(again.refused[0]?.why ?? ''), again.refused[0]?.why);

  /*
   * The check above is the polite one -- it looks first. This is the one that matters: two
   * people pressing the button in the same moment BOTH pass that look, and only the database
   * can settle it. Written straight past the service to prove the index is really there.
   */
  let raced = false;
  try {
    const row = await prisma.photoJob.create({
      data: {
        clientId: SHOP, productId: product.id, kind: 'VIEWS',
        colourName: 'Maroon', colourKey: 'maroon', variantIds: [maroon.variant.id],
        sourceImageUrl: 'https://example.invalid/x.jpg', jobKey: 'race',
        category: 'SAREE', modelId: 'saree1'
      }
    });
    madeJobs.add(row.id);
  } catch (err: any) {
    raced = err?.code === 'P2002';
  }
  check('the database refuses it even when the check is skipped (the real race)', raced);

  // ── Claiming ────────────────────────────────────────────────────────────────────────────────
  console.log('\nCLAIMING');

  const second = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: ['Amber']
  }));
  check('a second colour on the same product queues alongside it', second.made.length === 1,
    JSON.stringify(second.refused));

  const claimedA = await PhotoJobRunner.claimNext();
  check('a queued job is claimed', !!claimedA,
    'if this fails, PHOTO_JOBS_ONLY_CLIENTS does not include this shop');
  check('claiming moves it to RUNNING and counts the attempt',
    claimedA?.status === 'RUNNING' && claimedA?.attempts === 1);

  const claimedB = await PhotoJobRunner.claimNext();
  check('a shop only ever runs one at a time -- the second waits its turn', claimedB === null,
    claimedB ? `claimed ${claimedB.colourName} as well` : '');

  await prisma.photoJob.update({ where: { id: claimedA!.id }, data: { status: 'DONE', finishedAt: new Date() } });
  const claimedC = await PhotoJobRunner.claimNext();
  check('and it runs the moment the first one finishes', !!claimedC, 'the queue stalled');

  // Two runners reaching for the same row. Only one may win, and the loser must be told it
  // changed nothing rather than quietly running it too.
  await prisma.photoJob.update({ where: { id: claimedC!.id }, data: { status: 'QUEUED', attempts: 0 } });
  const [x, y] = await Promise.all([PhotoJobRunner.claimNext(), PhotoJobRunner.claimNext()]);
  check('two runners racing for one job: exactly one wins',
    [x, y].filter(Boolean).length === 1, `${!!x} / ${!!y}`);
  const winner = (x ?? y)!;

  // A laptop pointed at the production database must not reach into a real shop.
  if (process.env.PHOTO_JOBS_ONLY_CLIENTS) {
    const elsewhere = await makeProduct('Verify photo jobs, other shop (delete me)', 'Saree');
    await prisma.product.update({ where: { id: elsewhere.id }, data: { clientId: 'not-this-shop' } });
    const foreign = await prisma.photoJob.create({
      data: {
        clientId: 'not-this-shop', productId: elsewhere.id, kind: 'VIEWS',
        colourName: 'Scope', colourKey: 'scope', variantIds: [],
        sourceImageUrl: 'https://example.invalid/x.jpg', jobKey: 'scope',
        category: 'SAREE', modelId: 'saree1'
      }
    });
    madeJobs.add(foreign.id);
    await prisma.photoJob.update({ where: { id: winner.id }, data: { status: 'DONE', finishedAt: new Date() } });
    const reached = await PhotoJobRunner.claimNext();
    check('a scoped worker will not claim another shop\'s job', reached === null,
      reached ? `claimed ${reached.clientId}` : '');
    await prisma.photoJob.delete({ where: { id: foreign.id } });
    madeJobs.delete(foreign.id);
  }

  // ── A dead instance ─────────────────────────────────────────────────────────────────────────
  console.log('\nA DEAD INSTANCE (every push redeploys this service)');

  const stale = new Date(Date.now() - 30 * 60 * 1000);
  await prisma.photoJob.update({
    where: { id: winner.id },
    data: { status: 'RUNNING', attempts: 1, heartbeatAt: stale }
  });
  await PhotoJobRunner.recoverStranded();
  check('a stranded job goes back on the queue rather than sitting on RUNNING forever',
    (await prisma.photoJob.findUnique({ where: { id: winner.id } }))?.status === 'QUEUED');

  await prisma.photoJob.update({
    where: { id: winner.id },
    data: { status: 'RUNNING', attempts: MAX_ATTEMPTS, heartbeatAt: stale }
  });
  await PhotoJobRunner.recoverStranded();
  const givenUp = await prisma.photoJob.findUnique({ where: { id: winner.id } });
  check('but it is not retried forever -- past the limit it fails', givenUp?.status === 'FAILED');
  check('and says so in words, not a code',
    !!givenUp?.message && !/error|exception|undefined/i.test(givenUp.message), givenUp?.message ?? '');

  await prisma.photoJob.update({
    where: { id: winner.id },
    data: { status: 'RUNNING', attempts: 1, heartbeatAt: new Date() }
  });
  await PhotoJobRunner.recoverStranded();
  check('a job that is still breathing is left alone',
    (await prisma.photoJob.findUnique({ where: { id: winner.id } }))?.status === 'RUNNING');

  // ── Stopping ────────────────────────────────────────────────────────────────────────────────
  console.log('\nSTOPPING');

  await prisma.photoJob.update({ where: { id: winner.id }, data: { status: 'QUEUED' } });
  const cancelled = await photoJobQueue.cancel(SHOP, winner.id);
  check('a queued job is stopped outright', cancelled.status === 'CANCELLED');
  check('and is honest that nothing was used',
    /nothing was used/i.test(cancelled.message ?? ''), cancelled.message ?? '');

  await prisma.photoJob.update({ where: { id: winner.id }, data: { status: 'RUNNING', cancelRequested: false } });
  const flagged = await photoJobQueue.cancel(SHOP, winner.id);
  check('a running job is flagged rather than killed, so the runner can keep what it made',
    flagged.status === 'RUNNING' && flagged.cancelRequested === true);

  await prisma.photoJob.update({
    where: { id: winner.id },
    data: { status: 'DONE', finishedAt: new Date(), cancelRequested: false }
  });
  let refusedFinished = false;
  try { await photoJobQueue.cancel(SHOP, winner.id); }
  catch (err: any) { refusedFinished = err?.statusCode === 400; }
  check('a finished job cannot be stopped, and is not pretended otherwise', refusedFinished);

  // ── Running a half-made colour again ────────────────────────────────────────────────────────
  //
  // The case that was missing entirely until somebody pressed Stop and looked at the screen: a
  // colour keeps the views it made, and nothing offered to finish it. WHICH panel offers what is
  // decided in frontend/src/lib/photoSets.js and checked by verify-photo-sets.mjs. What this side
  // has to get right is which picture a re-run works from.
  console.log('\nRUNNING A HALF-MADE COLOUR AGAIN');

  await clearLive();

  const amberJob = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: ['Amber']
  }));
  check('a colour stopped at 2 of 4 can be run again', amberJob.made.length === 1,
    JSON.stringify(amberJob.refused));
  check('  ...from the shop\'s own photograph, never from a view we made',
    amberJob.made[0]?.sourceImageId === amber.own!.id,
    'it would have generated from a generated picture, copying its mistakes');

  const tealJob = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: ['Teal']
  }));
  check('a colour with nothing of its own works from the front view it does have',
    tealJob.made[0]?.sourceImageId === teal.views.front.id,
    'the one picture of that colour was ignored');

  const plumJob = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'COLOUR', colours: ['Plum']
  }));
  check('an empty colour is copied from a FINISHED set, not a half-made one',
    plumJob.made[0]?.sourceImageId === olive.views.front.id,
    'it took a half-made colour as the reference the others are matched to');

  // ── Its own history must not block it ───────────────────────────────────────────────────────
  console.log('\nRUNNING THE SAME COLOUR AGAIN LATER');

  await clearLive();
  const rerun = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: ['Maroon']
  }));
  check('a colour made last week can be made again -- the rule only covers live jobs',
    rerun.made.length === 1, JSON.stringify(rerun.refused));

  // ── Being told ──────────────────────────────────────────────────────────────────────────────
  console.log('\nBEING TOLD');

  await prisma.photoJob.update({
    where: { id: rerun.made[0].id },
    data: { status: 'DONE', finishedAt: new Date(), seenAt: null }
  });
  check('a finished job waits to be told about',
    (await photoJobQueue.unseen(SHOP)).some(j => j.id === rerun.made[0].id));

  await photoJobQueue.markSeen(SHOP, [rerun.made[0].id]);
  check('and stops waiting once somebody has seen it',
    !(await photoJobQueue.unseen(SHOP)).some(j => j.id === rerun.made[0].id));

  await prisma.photoJob.update({
    where: { id: tealJob.made[0].id },
    data: { status: 'CANCELLED', finishedAt: new Date(), seenAt: null }
  });
  check('a job somebody stopped themselves is not announced back at them',
    !(await photoJobQueue.unseen(SHOP)).some(j => j.id === tealJob.made[0].id));

  // ── Refusals ────────────────────────────────────────────────────────────────────────────────
  console.log('\nREFUSALS, IN WORDS');

  await clearLive();

  const dupatta = await makeProduct('Verify photo jobs, a dupatta (delete me)', 'Dupatta');
  await makeColour(dupatta.id, 'Pink', { own: true });
  let saidWhy = '';
  try {
    await photoJobQueue.enqueue({ clientId: SHOP, productId: dupatta.id, kind: 'VIEWS', colours: ['Pink'] });
  } catch (err: any) { saidWhy = err?.message ?? ''; }
  check('a dupatta has no model, and is told so rather than guessed at',
    /only photograph/i.test(saidWhy), saidWhy);
  check('and the refusal names what it CAN do',
    /saree/i.test(saidWhy) && /kurti/i.test(saidWhy), saidWhy);

  const noSource = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: ['Red']
  }));
  check('a colour with no photograph is refused, and told what to give us',
    noSource.made.length === 0 && /flat-lay/i.test(noSource.refused[0]?.why ?? ''),
    noSource.refused[0]?.why);

  const notOurs = await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: ['Definitely Not A Colour']
  });
  check('a colour that is not on the product is refused rather than invented',
    notOurs.made.length === 0 && notOurs.refused.length === 1, notOurs.refused[0]?.why);

  const trashed = await makeProduct('Verify photo jobs, binned (delete me)', 'Saree');
  await makeColour(trashed.id, 'Grey', { own: true });
  await prisma.product.update({ where: { id: trashed.id }, data: { trashedAt: new Date() } });
  let binned = '';
  try {
    await photoJobQueue.enqueue({ clientId: SHOP, productId: trashed.id, kind: 'VIEWS', colours: ['Grey'] });
  } catch (err: any) { binned = err?.message ?? ''; }
  check('a product in the bin is not photographed', /bin/i.test(binned), binned);

  let capped = '';
  try {
    await photoJobQueue.enqueue({
      clientId: SHOP, productId: product.id, kind: 'VIEWS',
      colours: Array.from({ length: 15 }, (_, i) => `Colour ${i}`)
    });
  } catch (err: any) { capped = err?.message ?? ''; }
  check('one press cannot queue fifteen generations', /wait for those|already have/i.test(capped), capped);

  // ── Somebody else's shop ────────────────────────────────────────────────────────────────────
  console.log('\nSOMEBODY ELSE\'S SHOP');

  let crossed = false;
  try {
    await photoJobQueue.enqueue({
      clientId: 'not-this-shop', productId: product.id, kind: 'VIEWS', colours: ['Maroon']
    });
  } catch (err: any) { crossed = err?.statusCode === 404; }
  check('a product cannot be photographed by a shop that does not own it', crossed);

  const someoneElsesPhoto = await prisma.productImage.findFirst({
    where: { product: { clientId: { not: SHOP } } }, select: { id: true }
  });
  if (someoneElsesPhoto) {
    let borrowed = false;
    try {
      await photoJobQueue.enqueue({
        clientId: SHOP, productId: product.id, kind: 'VIEWS',
        colours: ['Maroon'], sourceImageId: someoneElsesPhoto.id
      });
    } catch (err: any) { borrowed = err?.statusCode === 400; }
    check('and cannot be generated from another shop\'s photograph', borrowed);
  }

  let cancelledElsewhere = false;
  try { await photoJobQueue.cancel('not-this-shop', rerun.made[0].id); }
  catch (err: any) { cancelledElsewhere = err?.statusCode === 404; }
  check('and one shop cannot stop another shop\'s job', cancelledElsewhere);

  // ── The product going away ──────────────────────────────────────────────────────────────────
  console.log('\nTHE PRODUCT GOING AWAY MID-JOB');

  const doomed = await makeProduct('Verify photo jobs, deleted (delete me)', 'Saree');
  const doomedColour = await makeColour(doomed.id, 'Ochre', { own: true });
  const orphan = await prisma.photoJob.create({
    data: {
      clientId: SHOP, productId: doomed.id, kind: 'VIEWS',
      colourName: 'Ochre', colourKey: 'ochre', variantIds: [doomedColour.variant.id],
      sourceImageUrl: 'https://example.invalid/x.jpg', jobKey: 'verify',
      category: 'SAREE', modelId: 'saree1', status: 'RUNNING'
    }
  });
  await prisma.product.delete({ where: { id: doomed.id } });
  madeProducts.delete(doomed.id);
  check('deleting the product takes its jobs with it, leaving nothing to run',
    (await prisma.photoJob.findUnique({ where: { id: orphan.id } })) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`failed: ${failures.join(' | ')}`);
}

main()
  .catch(err => { console.error('\nSUITE BROKE:', err); failed++; })
  .finally(async () => {
    // Nothing this suite made may be left QUEUED: the worker would pick it up and spend a real
    // generation on a test.
    if (madeJobs.size) await prisma.photoJob.deleteMany({ where: { id: { in: [...madeJobs] } } });
    for (const id of madeProducts) await prisma.product.delete({ where: { id } }).catch(() => {});
    const leftover = await prisma.photoJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    if (leftover) console.log(`\nWARNING: ${leftover} job(s) still live -- check before the worker restarts.`);
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  });
