import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { safeMessage } from '../../lib/safeMessage';
import { catalogTryOnService, tryOnUsageService, jobKeyFor } from '../tryon';
import { imageService } from '../image.service';
import { VIEW_ORDER, API_VIEW_TO_LOCAL } from './catalog';

/**
 * Doing the work the browser used to do.
 *
 * Everything here was in the page: opening the stream to the photo studio, reading the frames,
 * cropping a contact sheet down to one pose, putting the bytes in storage and registering a row
 * for every size of the colour. It ran for the better part of a minute and it only existed while
 * that tab stayed on that screen.
 *
 * It is the same sequence, moved. Two things had to change in the moving, and both are marked
 * where they happen: the stall timer (a browser going away used to end a hung generation, and
 * nothing does that now) and replacing rather than adding a view (nobody re-ran a generation by
 * accident when it needed somebody sitting there, and a retry after a redeploy does exactly that).
 */

/**
 * How long a stream may say nothing before we give up on it.
 *
 * A generation takes about a minute in total and frames arrive throughout, so four minutes of
 * complete silence is not slowness, it is a stream that has died without closing. Nothing else
 * would ever end it: the socket stays open, and the job would sit on RUNNING forever holding up
 * every other colour that shop has queued.
 */
const STALL_AFTER_MS = 4 * 60 * 1000;

/** How often the row is touched, and the stop flag read. Cheap, and the only way a cancel on another instance reaches us. */
const HEARTBEAT_MS = 10 * 1000;

/**
 * One automatic retry, and no more.
 *
 * Every push redeploys this service, which strands whatever was running. Retrying once is the
 * difference between the shop getting their photographs and coming back to "it did not work,
 * press it again" -- which is the exact experience this whole change exists to remove. Retrying
 * forever would spend a shop's monthly allowance on a generation that may be failing for a
 * reason no amount of trying will fix.
 */
export const MAX_ATTEMPTS = 2;

/** How many jobs this process runs at once, across all shops. One shop still only ever gets one. */
const MAX_CONCURRENT = 2;

/**
 * Which shops this instance will work for.
 *
 * Empty means all of them, which is what production wants. A development machine points at the
 * production database, so an unscoped laptop would happily claim a real shop's colour, spend
 * their paid generation on it, and strand the job the moment the laptop sleeps. Set to the test
 * shop while testing and a suite cannot reach into somebody's real product.
 */
const ONLY_CLIENTS = String(env.PHOTO_JOBS_ONLY_CLIENTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

let running = 0;

/** The picture, whether the far end sent the bytes inline or a place to fetch them from. */
async function bytesFor(image: string): Promise<Buffer> {
  if (image.startsWith('data:')) {
    const comma = image.indexOf(',');
    if (comma < 0) throw new Error('The photo studio sent a picture we could not read.');
    return Buffer.from(image.slice(comma + 1), 'base64');
  }
  const res = await fetch(image);
  if (!res.ok) throw new Error('The photo studio sent a picture we could not read.');
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The far end occasionally returns one "view" as a contact sheet -- several near-identical renders
 * side by side on one backdrop -- instead of a single photograph. A real full-body shot is
 * portrait; a composite is landscape, roughly N times wider than one panel. When we see that
 * shape, assume N equal panels and keep the first.
 *
 * The same rule the browser used, done with sharp instead of a canvas. It is better here: the
 * canvas version re-encoded every picture whether it cropped or not, and this returns the
 * original bytes untouched unless there is really something to cut.
 */
async function keepFirstPoseOnly(bytes: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.width || !meta.height) return bytes;

    const ratio = meta.width / meta.height;
    if (ratio <= 1.15) return bytes;                       // an ordinary portrait shot

    const panels = Math.round(ratio / 0.75) || 1;          // ~0.75 = one full-body portrait
    if (panels <= 1) return bytes;

    return await sharp(bytes)
      .extract({ left: 0, top: 0, width: Math.floor(meta.width / panels), height: meta.height })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return bytes;   // rather the original than nothing
  }
}

type Job = Awaited<ReturnType<typeof prisma.photoJob.findFirstOrThrow>>;

/**
 * Saves one view against every size of the colour, and says how many stuck.
 *
 * The bytes go up ONCE and several rows point at them: red/S, red/M and red/L are one colour
 * with one photograph, and uploading it per size would store three copies of identical bytes.
 * imageService.deleteImage already knows this -- it removes the file only when the last row
 * using it goes.
 */
async function saveView(job: Job, view: string, image: string, superseded: Set<string>): Promise<number> {
  const cropped = await keepFirstPoseOnly(await bytesFor(image));
  const stored = await imageService.storeBytes(
    job.productId, job.clientId, `${view}.jpg`, cropped, 'image/jpeg'
  );

  /*
   * The flat-lay this was made from may have been deleted while the job ran. Checked rather than
   * assumed, because addImage refuses a generatedFromId it cannot find and would turn a deleted
   * reference into a failed view. Losing the note of where a picture came from is a small thing;
   * losing the picture is not.
   */
  const sourceStillThere = job.sourceImageId
    ? (await prisma.productImage.count({ where: { id: job.sourceImageId, productId: job.productId } })) > 0
    : false;

  const order = VIEW_ORDER.indexOf(view);
  let saved = 0;

  for (const variantId of job.variantIds) {
    /*
     * Replacing, not adding. A job retried after a redeploy generates all four views again, and
     * appending them would leave the colour with eight photographs: two fronts, two backs, and
     * no way for the shop to tell which is which.
     *
     * The old row is noted here and removed only once the whole job is over, NOT the moment its
     * replacement lands. That matters since a colour stopped part-way is now re-run from the
     * front view it already has: that front view is this job's source, the far end fetches it by
     * URL, and deleting the file the moment view one arrived would pull the source out from
     * under views two, three and four. Waiting costs a few seconds of the colour showing both
     * the old picture and the new one; not waiting risks the rest of the set.
     */
    const previous = await prisma.productImage.findMany({
      where: { productId: job.productId, variantId, generated: true, view },
      select: { id: true }
    });

    try {
      await imageService.addImage(job.productId, job.clientId, {
        variantId,
        url: stored.publicUrl,
        storagePath: stored.storagePath,
        fileName: stored.fileName,
        fileSize: stored.fileSize,
        altText: `${job.colourName}, ${view} view`,
        // The front leads. If the front never arrives, whatever came first leads instead, so a
        // half-finished colour still has a main photograph rather than none.
        isPrimary: view === 'front' || job.viewsDone === 0,
        imageType: 'GALLERY',
        generated: true,
        view,
        ...(sourceStillThere && job.sourceImageId ? { generatedFromId: job.sourceImageId } : {}),
        orderIndex: order < 0 ? 0 : order
      });
      saved++;
    } catch (err: any) {
      // That size was deleted while this ran. The other sizes of the colour are still worth
      // saving, so this is noted and stepped over rather than ending the job.
      console.warn(`[photo-jobs] ${job.id}: could not save ${view} against variant ${variantId}:`, err?.message);
      continue;
    }

    for (const old of previous) superseded.add(old.id);
  }

  return saved;
}

/**
 * Removes the pictures this job replaced, once it can no longer need them.
 *
 * Run whatever the outcome, including a cancel: a view that really was replaced should not be
 * left behind as a duplicate just because the job stopped after it. Anything that is now gone
 * anyway is ignored -- this is tidying, and it must never be the reason a finished job reports
 * a failure.
 */
async function removeSuperseded(job: Job, superseded: Set<string>) {
  for (const id of superseded) {
    await imageService.deleteImage(id, job.clientId).catch(() => { /* already gone */ });
  }
}

/**
 * What to say when somebody pressed Stop.
 *
 * In one place because there are two ways out of a cancelled generation and they must not say
 * different things. Aborting the fetch throws out of reader.read(), so the catch below is the
 * path a real Stop almost always takes -- and it was the one saying a bare "Stopped." while the
 * sentence that mentioned the two views already saved sat on the branch that hardly ever runs.
 * The shop pressed Stop knowing they had photographs coming; what they need told is how many
 * they kept.
 */
function stoppedMessage(viewsSaved: number): string {
  if (viewsSaved === 0) return 'Stopped before anything was made.';
  return viewsSaved === 1
    ? 'Stopped. The one view already made is kept.'
    : `Stopped. The ${viewsSaved} views already made are kept.`;
}

/** Writes down how it ended. Tolerates the row having been deleted with its product. */
async function finish(id: string, status: string, message: string | null) {
  try {
    await prisma.photoJob.update({
      where: { id },
      data: { status, message, finishedAt: new Date(), cancelRequested: false }
    });
  } catch (err: any) {
    // P2025: the product was deleted while this ran, and the job went with it. Nothing to record.
    if (err?.code !== 'P2025') throw err;
  }
}

export class PhotoJobRunner {

  /**
   * Takes the oldest queued job that belongs to a shop with nothing already running.
   *
   * The claim is a conditional update -- RUNNING only where it is still QUEUED -- and the count
   * it returns is what tells us whether we got it. Two instances reading the same row a
   * millisecond apart both see QUEUED; only one of them changes it, and the other is told it
   * changed nothing and moves on. Reading and then writing without that condition is the bug
   * that looks fine on one server and doubles every bill on two.
   *
   * One at a time per shop is deliberate and is not about load. Four colours at once is four
   * generations charged inside a minute, before anybody has seen whether the first is any good.
   */
  static async claimNext(): Promise<Job | null> {
    // A fragment rather than two copies of the query: the shape of the claim is the part that
    // must not drift, and it is the part that is easy to get subtly different between branches.
    const scope = ONLY_CLIENTS.length
      ? Prisma.sql`AND j."client_id" IN (${Prisma.join(ONLY_CLIENTS)})`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT j."id" FROM "photo_jobs" j
      WHERE j."status" = 'QUEUED'
        ${scope}
        AND NOT EXISTS (
          SELECT 1 FROM "photo_jobs" r
          WHERE r."client_id" = j."client_id" AND r."status" = 'RUNNING'
        )
      ORDER BY j."created_at" ASC
      LIMIT 1
    `;
    if (!rows.length) return null;

    const claimed = await prisma.photoJob.updateMany({
      where: { id: rows[0].id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        heartbeatAt: new Date(),
        attempts: { increment: 1 }
      }
    });
    if (claimed.count !== 1) return null;   // somebody else got there first

    return prisma.photoJob.findUnique({ where: { id: rows[0].id } });
  }

  /**
   * Runs one job to the end.
   *
   * Always finishes the row, whatever happens -- a job that throws its way out of here without
   * writing a status is a shop watching "being made" forever.
   */
  static async runJob(job: Job): Promise<void> {
    // Checked before anything is started, so a shop out of allowance is told rather than charged.
    try {
      await tryOnUsageService.assertWithinLimit(job.clientId);
    } catch (err: any) {
      await finish(job.id, 'FAILED', safeMessage(err?.message, 'This shop has used its picture generations for the month.'));
      return;
    }

    const abort = new AbortController();
    let stopped = false;            // the shop pressed stop
    let stalled = false;            // the stream went quiet and we gave up on it
    let viewsSaved = 0;
    let lastFrameAt = Date.now();
    // Pictures this run has replaced. Held until the very end -- see saveView.
    const superseded = new Set<string>();

    // One timer does both jobs: says we are still alive, and reads the stop flag. The flag is how
    // a cancel arriving on ANOTHER instance reaches this loop -- there is no other channel.
    const heartbeat = setInterval(async () => {
      if (Date.now() - lastFrameAt > STALL_AFTER_MS) {
        stalled = true;
        abort.abort();
        return;
      }
      try {
        const row = await prisma.photoJob.findUnique({
          where: { id: job.id },
          select: { cancelRequested: true }
        });
        // The row is gone (its product was deleted) or the shop pressed stop. Either way, stop.
        if (!row || row.cancelRequested) { stopped = true; abort.abort(); return; }
        await prisma.photoJob.update({ where: { id: job.id }, data: { heartbeatAt: new Date() } });
      } catch { /* a missed heartbeat is not worth ending a generation over */ }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const upstream = await catalogTryOnService.streamGenerateCatalog(
        {
          modelId: job.modelId,
          category: job.category,
          // A URL, not bytes: the far end fetches it itself.
          saree: job.sourceImageUrl,
          // Only a colour job recolours. Border and blouse are deliberately left alone -- they
          // are usually a contrast the shop chose, and recolouring them sells a garment that
          // does not exist.
          ...(job.kind === 'COLOUR'
            ? { color: { name: job.colourName, hex: (job.colourHex || '').toLowerCase() || undefined } }
            : {}),
          // The job's name at the far end, which is also what cancelling it has to say. The
          // tenant is put in front here and never by whoever asked for the job.
          clientId: jobKeyFor(job.clientId, job.jobKey)
        },
        abort.signal,
        job.clientId
      );

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        void tryOnUsageService.record(job.clientId, { started: true, failed: true });
        // Kept where we can read it; the shop is told the one thing they can act on. The far
        // end's own words go in the log, never on a shop owner's screen.
        console.error(`[photo-jobs] ${job.id}: upstream refused (${upstream.status}):`, text.slice(0, 500));
        await finish(job.id, 'FAILED', 'The photo studio could not be reached just now. Your photos are safe -- please try again in a minute.');
        return;
      }

      void tryOnUsageService.record(job.clientId, { started: true });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let upstreamError: string | null = null;

      // The same three traps the browser reader had to get right: keepalive comment lines that
      // are not events, a frame split across two network chunks, and views arriving one at a
      // time rather than all at the end.
      reading: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastFrameAt = Date.now();

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;

            let data: any;
            try { data = JSON.parse(line.slice(6)); } catch { continue; }

            if (data.type === 'VIEW_READY') {
              const view = API_VIEW_TO_LOCAL[data.view] || data.view;
              const saved = await saveView(job, view, data.image, superseded);
              if (saved === 0) {
                // Every size of this colour has gone. There is nowhere left to put the
                // photographs, so carrying on would spend the rest of the generation on nothing.
                upstreamError = 'That colour was removed while its photographs were being made.';
                abort.abort();
                break reading;
              }
              viewsSaved++;
              // Read back on the next loop, and it is what the shop's screen counts.
              job = await prisma.photoJob.update({
                where: { id: job.id },
                data: { viewsDone: viewsSaved, heartbeatAt: new Date() }
              });
            } else if (data.type === 'ERROR') {
              // The far end's wording is written for whoever built it. Through the same gate as
              // every other message before it can reach a shop owner's screen.
              upstreamError = safeMessage(data.error, 'The photo studio could not finish this one. Please try again.');
              break reading;
            } else if (data.type === 'COMPLETE') {
              break reading;
            }
          }
        }
      }

      if (stopped) {
        void tryOnUsageService.record(job.clientId, { cancelled: true });
        await finish(job.id, 'CANCELLED', stoppedMessage(viewsSaved));
        return;
      }

      if (stalled) {
        void tryOnUsageService.record(job.clientId, { failed: true });
        await finish(job.id, 'FAILED', 'The photo studio stopped responding. Please try this one again.');
        return;
      }

      if (upstreamError) {
        void tryOnUsageService.record(job.clientId, { failed: true, viewsGenerated: viewsSaved });
        // Partial work is kept and SAID. Three of four is a real outcome, and a shop that is
        // told "it failed" when three photographs are sitting there will not go and look.
        await finish(job.id, 'FAILED', viewsSaved > 0
          ? `${upstreamError} The ${viewsSaved} view${viewsSaved === 1 ? '' : 's'} already made ${viewsSaved === 1 ? 'is' : 'are'} kept.`
          : upstreamError);
        return;
      }

      if (viewsSaved === 0) {
        void tryOnUsageService.record(job.clientId, { failed: true });
        await finish(job.id, 'FAILED', 'The photo studio finished without sending any photographs. Please try again.');
        return;
      }

      void tryOnUsageService.record(job.clientId, { completed: true, viewsGenerated: viewsSaved });
      await finish(job.id, 'DONE', viewsSaved < job.viewsTotal
        ? `${viewsSaved} of ${job.viewsTotal} views were made. Run it again if you want the rest.`
        : null);

    } catch (err: any) {
      if (stopped) {
        void tryOnUsageService.record(job.clientId, { cancelled: true });
        await finish(job.id, 'CANCELLED', stoppedMessage(viewsSaved));
        return;
      }
      console.error(`[photo-jobs] ${job.id} failed:`, err?.message);
      void tryOnUsageService.record(job.clientId, { failed: true, viewsGenerated: viewsSaved });
      await finish(job.id, 'FAILED', safeMessage(
        err?.message,
        'Something went wrong while making these photographs. Please try again.'
      ));
    } finally {
      clearInterval(heartbeat);
      await removeSuperseded(job, superseded);
    }
  }

  /**
   * Puts stranded jobs back on the queue.
   *
   * A RUNNING row whose heartbeat stopped belongs to an instance that is gone -- almost always a
   * redeploy, which happens on every push. Without this the job sits on RUNNING forever: the
   * shop watches "being made" that will never finish, and because one shop runs one job at a
   * time, everything else they queued waits behind it.
   *
   * Run at boot and on a timer. On a timer as well as at boot because the instance that died
   * may not be the instance that restarts.
   */
  static async recoverStranded(): Promise<number> {
    const deadline = new Date(Date.now() - STALL_AFTER_MS);

    // Beyond a second go. Failed rather than retried: whatever is wrong is not being fixed by
    // trying again, and a shop's allowance should not pay to find that out repeatedly.
    const exhausted = await prisma.photoJob.updateMany({
      where: {
        status: 'RUNNING',
        attempts: { gte: MAX_ATTEMPTS },
        OR: [{ heartbeatAt: { lt: deadline } }, { heartbeatAt: null, startedAt: { lt: deadline } }]
      },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        message: 'This was interrupted and did not finish. Anything already made is kept -- please run it again.'
      }
    });

    const requeued = await prisma.photoJob.updateMany({
      where: {
        status: 'RUNNING',
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ heartbeatAt: { lt: deadline } }, { heartbeatAt: null, startedAt: { lt: deadline } }]
      },
      data: { status: 'QUEUED', heartbeatAt: null }
    });

    if (exhausted.count || requeued.count) {
      console.log(`[photo-jobs] recovered ${requeued.count} stranded job(s), gave up on ${exhausted.count}`);
    }
    return requeued.count + exhausted.count;
  }

  /** One pass: fill the free slots with whatever is waiting. */
  static async tick(): Promise<void> {
    while (running < MAX_CONCURRENT) {
      const job = await PhotoJobRunner.claimNext();
      if (!job) return;

      running++;
      // Deliberately not awaited: the slot is occupied by the bookkeeping above, and awaiting
      // here would make MAX_CONCURRENT mean one.
      void PhotoJobRunner.runJob(job)
        .catch(err => console.error(`[photo-jobs] ${job.id} escaped:`, err?.message))
        .finally(() => { running--; });
    }
  }
}
