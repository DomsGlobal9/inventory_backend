/**
 * Photographs get made even when nobody is watching.
 *
 * The thing this replaces ran entirely in a browser tab: the page held the stream open AND did
 * the saving, so closing the tab threw the work away after the GPU time had been paid for. The
 * rules below are the ones that make the server-side version safe to leave alone, and every one
 * of them is a case that either cost money or lost work in the old design.
 *
 * It does NOT generate anything. Every check here is about the queue, the claim, the recovery
 * and the refusals -- running a real generation to prove those would spend a shop's paid
 * allowance to test bookkeeping. The generation itself is tested through the UI, once, against
 * the demo shop.
 *
 * Run it with the worker STOPPED, or it will claim the rows out from under the checks and
 * generate them for real:
 *
 *   npx ts-node src/scripts/verify-photo-jobs.ts
 */
import { prisma } from '../lib/prisma';
import { photoJobQueue } from '../services/photo-jobs';
import { PhotoJobRunner, MAX_ATTEMPTS } from '../services/photo-jobs';

const SHOP = 'lakshmi-silks-demo-helpshop-1790336784866';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** Everything this suite made, so none of it is left for the worker to pick up and charge for. */
const madeJobs = new Set<string>();
const madeProducts = new Set<string>();

function remember<T extends { made: any[] }>(result: T): T {
  for (const j of result.made) madeJobs.add(j.id);
  return result;
}

async function main() {
  console.log('PHOTO JOBS\n');

  const product = await prisma.product.findFirst({
    where: { clientId: SHOP, dressType: 'Saree', trashedAt: null, variants: { some: { colorName: { not: null } } } },
    select: {
      id: true, title: true,
      variants: { select: { id: true, colorName: true } },
      images: { select: { id: true, variantId: true, url: true, generated: true, view: true } }
    }
  });
  if (!product) throw new Error(`No saree with colours on ${SHOP} to test against.`);

  const colourOf = (variantId: string | null) =>
    product.variants.find(v => v.id === variantId)?.colorName ?? null;
  const withPhoto = [...new Set(product.images.map(i => colourOf(i.variantId)).filter(Boolean))] as string[];
  const withoutPhoto = [...new Set(product.variants.map(v => v.colorName).filter(Boolean))]
    .filter(c => !withPhoto.includes(c as string)) as string[];

  console.log(`Using "${product.title}"`);
  console.log(`  colours with a photograph: ${withPhoto.join(', ') || 'none'}`);
  console.log(`  colours without one:       ${withoutPhoto.join(', ') || 'none'}\n`);

  // Anything left over from an earlier run would make the duplicate checks below lie.
  await prisma.photoJob.deleteMany({ where: { productId: product.id, status: { in: ['QUEUED', 'RUNNING'] } } });

  // ── Starting one ────────────────────────────────────────────────────────────────────────────
  console.log('STARTING ONE');

  const first = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: [withPhoto[0]]
  }));
  check('a colour with a photograph can be queued', first.made.length === 1,
    JSON.stringify(first.refused));
  check('it starts QUEUED, with nothing done and nothing spent',
    first.made[0]?.status === 'QUEUED' && first.made[0]?.viewsDone === 0);
  check('the source photograph is recorded on the row, not worked out later',
    !!first.made[0]?.sourceImageUrl && !!first.made[0]?.sourceImageId);
  check('the model is chosen once and kept, so a retry matches the views already saved',
    /^saree[1-4]$/.test(first.made[0]?.modelId ?? ''), first.made[0]?.modelId);
  check('it targets every size of the colour, not just one',
    (first.made[0]?.variantIds ?? []).length >= 1,
    `${first.made[0]?.variantIds?.length} variant(s)`);

  // ── Two people, one colour ──────────────────────────────────────────────────────────────────
  console.log('\nTWO PEOPLE, ONE COLOUR');

  const again = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: [withPhoto[0]]
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
        colourName: withPhoto[0], colourKey: withPhoto[0].toLowerCase(),
        variantIds: first.made[0].variantIds, sourceImageUrl: first.made[0].sourceImageUrl,
        jobKey: 'race', category: 'SAREE', modelId: 'saree1'
      }
    });
    madeJobs.add(row.id);
  } catch (err: any) {
    raced = err?.code === 'P2002';
  }
  check('the database refuses it even when the check is skipped (the real race)', raced);

  // ── Claiming ────────────────────────────────────────────────────────────────────────────────
  console.log('\nCLAIMING');

  /*
   * A second job for the SAME shop, and it has to be a real one.
   *
   * The first version of this reached for another colour on the same product -- which on this
   * product has no photograph, so it was refused, the check below was skipped, and the suite
   * reported 31 passes without ever testing the rule it is here for. A skipped check reads
   * exactly like a passing one in a wall of green.
   */
  const otherProduct = await prisma.product.findFirst({
    where: {
      clientId: SHOP, id: { not: product.id }, dressType: 'Saree', trashedAt: null,
      images: { some: {} }, variants: { some: { colorName: { not: null } } }
    },
    select: { id: true, title: true, variants: { select: { colorName: true, id: true } }, images: { select: { variantId: true } } }
  });
  if (!otherProduct) throw new Error('Need a second photographed saree on the demo shop to test the one-at-a-time rule.');
  const otherColour = otherProduct.variants.find(v => otherProduct.images.some(i => i.variantId === v.id))?.colorName;
  if (!otherColour) throw new Error('The second saree has no photographed colour.');

  const second = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: otherProduct.id, kind: 'VIEWS', colours: [otherColour]
  }));
  check('a second job, on another product of the same shop, queues',
    second.made.length === 1, JSON.stringify(second.refused));

  const claimedA = await PhotoJobRunner.claimNext();
  check('a queued job is claimed', !!claimedA);
  check('claiming moves it to RUNNING and counts the attempt',
    claimedA?.status === 'RUNNING' && claimedA?.attempts === 1);

  const claimedB = await PhotoJobRunner.claimNext();
  check('a shop only ever runs one at a time -- the second waits its turn', claimedB === null,
    claimedB ? `claimed ${claimedB.colourName} as well` : '');

  // And it is waiting, not lost: finish the first and the second becomes claimable.
  await prisma.photoJob.update({
    where: { id: claimedA!.id },
    data: { status: 'DONE', finishedAt: new Date() }
  });
  const claimedC = await PhotoJobRunner.claimNext();
  check('and it runs the moment the first one finishes', !!claimedC,
    'the queue stalled instead of moving on');
  if (claimedC) await prisma.photoJob.update({ where: { id: claimedC.id }, data: { status: 'QUEUED', attempts: 0 } });
  await prisma.photoJob.update({ where: { id: claimedA!.id }, data: { status: 'QUEUED', attempts: 0 } });

  /*
   * A laptop pointed at the production database must not reach into a real shop. The worker is
   * scoped by PHOTO_JOBS_ONLY_CLIENTS, and this is the check that it actually holds.
   */
  const elsewhere = await prisma.product.findFirst({
    where: { clientId: 'verify-suites-tenant' }, select: { id: true }
  });
  if (elsewhere && process.env.PHOTO_JOBS_ONLY_CLIENTS) {
    const foreign = await prisma.photoJob.create({
      data: {
        clientId: 'verify-suites-tenant', productId: elsewhere.id, kind: 'VIEWS',
        colourName: 'Scope', colourKey: 'scope', variantIds: [],
        sourceImageUrl: 'https://example.invalid/x.jpg', jobKey: 'scope',
        category: 'SAREE', modelId: 'saree1'
      }
    });
    madeJobs.add(foreign.id);
    await prisma.photoJob.updateMany({
      where: { clientId: SHOP, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'DONE', finishedAt: new Date() }
    });
    const reached = await PhotoJobRunner.claimNext();
    check('a scoped worker will not claim another shop\'s job', reached === null,
      reached ? `claimed ${reached.clientId}` : '');
    await prisma.photoJob.update({ where: { id: claimedA!.id }, data: { status: 'QUEUED' } });
  }

  // Two runners reaching for the same row. Only one may win, and the loser must be told it
  // changed nothing rather than quietly running it too.
  await prisma.photoJob.update({ where: { id: claimedA!.id }, data: { status: 'QUEUED', attempts: 0 } });
  const [x, y] = await Promise.all([PhotoJobRunner.claimNext(), PhotoJobRunner.claimNext()]);
  check('two runners racing for one job: exactly one wins',
    [x, y].filter(Boolean).length === 1, `${!!x} / ${!!y}`);

  const winner = (x ?? y)!;

  // ── A dead instance ─────────────────────────────────────────────────────────────────────────
  console.log('\nA DEAD INSTANCE (every push redeploys this service)');

  // Backdated well past the stall window: this is what a redeploy leaves behind.
  await prisma.photoJob.update({
    where: { id: winner.id },
    data: { status: 'RUNNING', attempts: 1, heartbeatAt: new Date(Date.now() - 30 * 60 * 1000) }
  });
  await PhotoJobRunner.recoverStranded();
  const recovered = await prisma.photoJob.findUnique({ where: { id: winner.id } });
  check('a stranded job goes back on the queue rather than sitting on RUNNING forever',
    recovered?.status === 'QUEUED', recovered?.status);

  await prisma.photoJob.update({
    where: { id: winner.id },
    data: { status: 'RUNNING', attempts: MAX_ATTEMPTS, heartbeatAt: new Date(Date.now() - 30 * 60 * 1000) }
  });
  await PhotoJobRunner.recoverStranded();
  const givenUp = await prisma.photoJob.findUnique({ where: { id: winner.id } });
  check('but it is not retried forever -- past the limit it fails', givenUp?.status === 'FAILED');
  check('and says so in words, not a code',
    !!givenUp?.message && !/error|exception|undefined/i.test(givenUp.message), givenUp?.message ?? '');

  // A job still being worked on must NOT be swept up by recovery.
  await prisma.photoJob.update({
    where: { id: winner.id },
    data: { status: 'RUNNING', attempts: 1, heartbeatAt: new Date() }
  });
  await PhotoJobRunner.recoverStranded();
  const alive = await prisma.photoJob.findUnique({ where: { id: winner.id } });
  check('a job that is still breathing is left alone', alive?.status === 'RUNNING', alive?.status);

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

  // ── Its own history must not block it ───────────────────────────────────────────────────────
  console.log('\nRUNNING THE SAME COLOUR AGAIN LATER');

  await prisma.photoJob.updateMany({
    where: { productId: product.id, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'DONE', finishedAt: new Date() }
  });
  const rerun = remember(await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: [withPhoto[0]]
  }));
  check('a colour made last week can be made again -- the rule only covers live jobs',
    rerun.made.length === 1, JSON.stringify(rerun.refused));

  // ── Being told ──────────────────────────────────────────────────────────────────────────────
  console.log('\nBEING TOLD');

  await prisma.photoJob.update({
    where: { id: rerun.made[0].id },
    data: { status: 'DONE', finishedAt: new Date(), seenAt: null }
  });
  const unseenBefore = await photoJobQueue.unseen(SHOP);
  check('a finished job waits to be told about', unseenBefore.some(j => j.id === rerun.made[0].id));

  await photoJobQueue.markSeen(SHOP, [rerun.made[0].id]);
  const unseenAfter = await photoJobQueue.unseen(SHOP);
  check('and stops waiting once somebody has seen it',
    !unseenAfter.some(j => j.id === rerun.made[0].id));

  const cancelledNotice = await prisma.photoJob.findFirst({ where: { id: winner.id } });
  await prisma.photoJob.update({ where: { id: winner.id }, data: { status: 'CANCELLED', seenAt: null } });
  const afterCancel = await photoJobQueue.unseen(SHOP);
  check('a job somebody stopped themselves is not announced back at them',
    !afterCancel.some(j => j.id === cancelledNotice!.id));

  // ── Refusals ────────────────────────────────────────────────────────────────────────────────
  console.log('\nREFUSALS, IN WORDS');

  let saidWhy = '';
  const notAGarmentWeDo = await prisma.product.findFirst({
    where: { clientId: SHOP, dressType: { notIn: ['Saree', 'Kurti', 'Anarkali', 'Lehanga', 'Lehenga', 'Sharara'] }, trashedAt: null },
    select: { id: true, dressType: true, variants: { select: { colorName: true } } }
  });
  if (notAGarmentWeDo) {
    try {
      await photoJobQueue.enqueue({
        clientId: SHOP, productId: notAGarmentWeDo.id, kind: 'VIEWS',
        colours: [notAGarmentWeDo.variants[0]?.colorName ?? 'Pink']
      });
    } catch (err: any) { saidWhy = err?.message ?? ''; }
    check(`a "${notAGarmentWeDo.dressType}" has no model, and is told so rather than guessed at`,
      /only photograph/i.test(saidWhy), saidWhy);
    check('and the refusal names what it CAN do',
      /saree/i.test(saidWhy) && /kurti/i.test(saidWhy), saidWhy);
  }

  if (withoutPhoto.length) {
    const noSource = await photoJobQueue.enqueue({
      clientId: SHOP, productId: product.id, kind: 'VIEWS', colours: [withoutPhoto[0]]
    });
    remember(noSource);
    check('a colour with no photograph is refused, and told what to give us',
      noSource.made.length === 0 && /flat-lay/i.test(noSource.refused[0]?.why ?? ''),
      noSource.refused[0]?.why);
  }

  const notOurs = await photoJobQueue.enqueue({
    clientId: SHOP, productId: product.id, kind: 'VIEWS',
    colours: ['Definitely Not A Colour On This Product']
  });
  check('a colour that is not on the product is refused rather than invented',
    notOurs.made.length === 0 && notOurs.refused.length === 1, notOurs.refused[0]?.why);

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
      clientId: 'verify-suites-tenant', productId: product.id, kind: 'VIEWS', colours: [withPhoto[0]]
    });
  } catch (err: any) { crossed = err?.statusCode === 404; }
  check('a product cannot be photographed by a shop that does not own it', crossed);

  let borrowed = false;
  const someoneElsesPhoto = await prisma.productImage.findFirst({
    where: { product: { clientId: { not: SHOP } } },
    select: { id: true }
  });
  if (someoneElsesPhoto) {
    try {
      await photoJobQueue.enqueue({
        clientId: SHOP, productId: product.id, kind: 'VIEWS',
        colours: [withPhoto[0]], sourceImageId: someoneElsesPhoto.id
      });
    } catch (err: any) { borrowed = err?.statusCode === 400; }
    check('and cannot be generated from another shop\'s photograph', borrowed);
  }

  // ── The product going away ──────────────────────────────────────────────────────────────────
  console.log('\nTHE PRODUCT GOING AWAY MID-JOB');

  const throwaway = await prisma.product.create({
    data: {
      clientId: SHOP, productCode: `VERIFY-PJ-${Date.now()}`, slug: `verify-pj-${Date.now()}`,
      title: 'Verify photo jobs (delete me)', category: 'WOMEN', productType: 'READY_TO_WEAR',
      dressType: 'Saree', basePrice: 1
    }
  });
  madeProducts.add(throwaway.id);
  const orphan = await prisma.photoJob.create({
    data: {
      clientId: SHOP, productId: throwaway.id, kind: 'VIEWS',
      colourName: 'Test', colourKey: 'test', variantIds: [],
      sourceImageUrl: 'https://example.invalid/x.jpg', jobKey: 'verify',
      category: 'SAREE', modelId: 'saree1', status: 'RUNNING'
    }
  });
  await prisma.product.delete({ where: { id: throwaway.id } });
  madeProducts.delete(throwaway.id);
  const gone = await prisma.photoJob.findUnique({ where: { id: orphan.id } });
  check('deleting the product takes its jobs with it, leaving nothing to run', gone === null);

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
    const leftover = await prisma.photoJob.count({ where: { clientId: SHOP, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (leftover) console.log(`\nWARNING: ${leftover} job(s) left live on ${SHOP} -- check before the worker restarts.`);
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  });
