import { prisma } from '../../lib/prisma';
import { resolveTryOnCategory, pickRandomModelId } from './catalog';

/**
 * Making, listing, stopping and clearing photo jobs.
 *
 * Everything in here is about the ROW. Nothing here talks to the photo studio -- that is the
 * runner's job -- which is what lets a shop queue four colours in a tenth of a second and walk
 * away, and lets any instance answer "how is it going" without holding the work.
 */

/**
 * How many a shop may have waiting.
 *
 * Not a technical limit -- the table would not notice a thousand. It is a limit on how much a
 * shop can spend in one press. Each job is a generation off their monthly allowance, and a
 * product with twenty colours would otherwise queue twenty of them from one button before
 * anybody had seen whether the first came out right.
 */
const MAX_QUEUED_PER_CLIENT = 10;

/** A colour a job could not be made for, and why -- in words the shop is shown as written. */
export interface Refusal { colour: string; why: string; }

export interface EnqueueRequest {
  clientId: string;
  productId: string;
  requestedBy?: string | null;
  /** 'VIEWS' -- four views from a photograph. 'COLOUR' -- this colour from another's front view. */
  kind: 'VIEWS' | 'COLOUR';
  /** Colour names, as the shop wrote them. */
  colours: string[];
  /**
   * A specific photograph to work from. Sent when the shop has just uploaded a flat-lay for this
   * job; left out otherwise, and the source is worked out here from what the product already has.
   */
  sourceImageId?: string | null;
}

type ColourGroup = {
  name: string;
  hex: string | null;
  variantIds: string[];
  images: { id: string; url: string; imageType: string; isPrimary: boolean; generated: boolean; view: string | null }[];
};

/** The colours of a product, each with its variants and its photographs. */
async function coloursOf(productId: string, clientId: string): Promise<ColourGroup[]> {
  const [variants, images] = await Promise.all([
    prisma.productVariant.findMany({
      where: { productId, clientId },
      select: { id: true, colorName: true, hexCode: true }
    }),
    prisma.productImage.findMany({
      where: { productId, product: { clientId } },
      select: { id: true, url: true, imageType: true, isPrimary: true, generated: true, view: true, variantId: true }
    })
  ]);

  const byColour = new Map<string, ColourGroup>();
  for (const v of variants) {
    if (!v.colorName) continue;
    const key = v.colorName.toLowerCase();
    if (!byColour.has(key)) byColour.set(key, { name: v.colorName, hex: v.hexCode, variantIds: [], images: [] });
    byColour.get(key)!.variantIds.push(v.id);
  }
  for (const img of images) {
    if (!img.variantId) continue;
    for (const c of byColour.values()) {
      if (c.variantIds.includes(img.variantId)) c.images.push(img);
    }
  }
  return [...byColour.values()];
}

/**
 * What to generate FROM, in the order that respects what the shop meant.
 *
 * The same order the Images tab uses, deliberately: a flat-lay handed over for this job first,
 * then the main photograph, then anything. If the two disagreed, the picture the shop was shown
 * on screen and the picture the job actually used would be different ones.
 */
function sourceForViews(colour: ColourGroup) {
  return colour.images.find(i => i.imageType === 'RAW_UPLOAD')
    ?? colour.images.find(i => i.isPrimary)
    ?? colour.images[0]
    ?? null;
}

/** A generated front view, anywhere on the product: what an empty colour is copied from. */
function sourceForColour(colours: ColourGroup[]) {
  for (const c of colours) {
    const front = c.images.find(i => i.generated && i.view === 'front');
    if (front) return front;
  }
  return null;
}

export class PhotoJobQueue {

  /**
   * Puts one job on the queue per colour asked for, and says which it could not.
   *
   * Nothing is generated here and nothing is charged: this returns as fast as any other button
   * in the app, which is the entire point of the change. The shop is free the moment it answers.
   *
   * Partial success is a real answer. Three colours queued and one refused because somebody
   * deleted its sizes a minute ago is better than refusing all four and making them work out
   * which one was the problem.
   */
  async enqueue(req: EnqueueRequest): Promise<{ made: any[]; refused: Refusal[] }> {
    const product = await prisma.product.findFirst({
      where: { id: req.productId, clientId: req.clientId },
      select: { id: true, dressType: true, trashedAt: true }
    });
    if (!product) throw { statusCode: 404, message: 'That product could not be found.' };
    if (product.trashedAt) {
      throw { statusCode: 400, message: 'That product is in the bin. Restore it before making photographs for it.' };
    }

    const category = resolveTryOnCategory(product.dressType);
    if (!category) {
      throw {
        statusCode: 400,
        message: 'We can only photograph sarees, kurtis, anarkalis, lehengas and shararas on a model. '
          + 'Set the dress type to one of those, or upload your own photographs.'
      };
    }

    const wanted = [...new Set((req.colours || []).map(c => String(c || '').trim()).filter(Boolean))];
    if (wanted.length === 0) throw { statusCode: 400, message: 'Choose at least one colour to photograph.' };

    const waiting = await prisma.photoJob.count({
      where: { clientId: req.clientId, status: { in: ['QUEUED', 'RUNNING'] } }
    });
    if (waiting + wanted.length > MAX_QUEUED_PER_CLIENT) {
      throw {
        statusCode: 400,
        message: `You already have ${waiting} set${waiting === 1 ? '' : 's'} of photographs being made. `
          + 'Wait for those to finish before starting more.'
      };
    }

    const colours = await coloursOf(req.productId, req.clientId);

    // Sent when the shop has just uploaded a flat-lay for this run. Checked against this product
    // rather than trusted: an id arriving from a browser must never reach another shop's picture.
    let given: { id: string; url: string } | null = null;
    if (req.sourceImageId) {
      given = await prisma.productImage.findFirst({
        where: { id: req.sourceImageId, productId: req.productId, product: { clientId: req.clientId } },
        select: { id: true, url: true }
      });
      if (!given) throw { statusCode: 400, message: 'That photograph does not belong to this product.' };
    }

    // Worked out once, not per colour: every colour in a COLOUR run is copied from the same
    // front view, and looking it up each time would let it change halfway down the list.
    const copyFrom = req.kind === 'COLOUR' ? (given ?? sourceForColour(colours)) : null;

    const made: any[] = [];
    const refused: Refusal[] = [];

    for (const name of wanted) {
      const colour = colours.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (!colour) { refused.push({ colour: name, why: 'That colour is no longer on this product.' }); continue; }
      if (colour.variantIds.length === 0) { refused.push({ colour: name, why: 'That colour has no sizes to save photographs against.' }); continue; }

      const source = req.kind === 'COLOUR' ? copyFrom : (given ?? sourceForViews(colour));
      if (!source?.url) {
        refused.push({
          colour: name,
          why: req.kind === 'COLOUR'
            ? 'There is no finished front view on this product to copy from yet.'
            : 'That colour has no photograph to work from. Give us a flat-lay of it first.'
        });
        continue;
      }

      try {
        const job = await prisma.photoJob.create({
          data: {
            clientId: req.clientId,
            productId: req.productId,
            kind: req.kind,
            colourName: colour.name,
            colourKey: colour.name.toLowerCase(),
            colourHex: colour.hex,
            variantIds: colour.variantIds,
            sourceImageId: source.id,
            sourceImageUrl: source.url,
            // The suffix only. The tenant is put in front by jobKeyFor when the far end is told.
            jobKey: `${req.kind === 'COLOUR' ? 'colour' : 'views'}-${colour.name}`,
            category,
            modelId: pickRandomModelId(category),
            requestedBy: req.requestedBy ?? null
          }
        });
        made.push(job);
      } catch (err: any) {
        // The partial unique index did its job: somebody else is already making this colour.
        // Reached when two people press the button at the same moment -- the check above cannot
        // catch that, because between reading and writing is exactly where they both land.
        if (err?.code === 'P2002') {
          refused.push({ colour: colour.name, why: 'That colour is already being made.' });
          continue;
        }
        throw err;
      }
    }

    return { made, refused };
  }

  /** Everything still to happen or happening now, for one shop. */
  async active(clientId: string, productId?: string) {
    return prisma.photoJob.findMany({
      where: { clientId, status: { in: ['QUEUED', 'RUNNING'] }, ...(productId ? { productId } : {}) },
      orderBy: { createdAt: 'asc' }
    });
  }

  /**
   * Finished, and nobody has been told yet.
   *
   * This is the whole of "notify me when it is done". The row stays unseen until somebody looks,
   * so finishing while the shop is on another screen, signed out, or gone home for the night all
   * end the same way: it is waiting for them.
   *
   * Cancelled jobs are not included. Somebody pressed stop; they know.
   */
  async unseen(clientId: string) {
    return prisma.photoJob.findMany({
      where: { clientId, status: { in: ['DONE', 'FAILED'] }, seenAt: null },
      orderBy: { finishedAt: 'desc' },
      take: 25
    });
  }

  /** Recent history for one product, for the Images tab to show what happened. */
  async forProduct(clientId: string, productId: string) {
    return prisma.photoJob.findMany({
      where: { clientId, productId },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
  }

  /**
   * Stop one.
   *
   * A queued job is simply cancelled -- nothing has been spent. A running one is flagged, and
   * the caller tells the photo studio separately: the runner may be on another instance and the
   * flag is the only thing that reaches it, while the far end is what actually ends the stream.
   *
   * Views already saved are kept, always. Three photographs the shop can see are worth more
   * than the tidiness of an all-or-nothing rule.
   */
  async cancel(clientId: string, id: string) {
    const job = await prisma.photoJob.findFirst({ where: { id, clientId } });
    if (!job) throw { statusCode: 404, message: 'That job could not be found.' };

    if (job.status === 'QUEUED') {
      return prisma.photoJob.update({
        where: { id },
        data: {
          status: 'CANCELLED', cancelRequested: true, finishedAt: new Date(),
          message: 'Stopped before it started. Nothing was used.'
        }
      });
    }

    if (job.status === 'RUNNING') {
      return prisma.photoJob.update({ where: { id }, data: { cancelRequested: true } });
    }

    // Already finished one way or another. Saying so is better than pretending it worked.
    throw { statusCode: 400, message: 'That set of photographs has already finished.' };
  }

  /** Marks notices as told. Everything finished, or just the ones named. */
  async markSeen(clientId: string, ids?: string[]) {
    const result = await prisma.photoJob.updateMany({
      where: {
        clientId,
        seenAt: null,
        status: { in: ['DONE', 'FAILED'] },
        ...(ids && ids.length ? { id: { in: ids } } : {})
      },
      data: { seenAt: new Date() }
    });
    return { seen: result.count };
  }
}

export const photoJobQueue = new PhotoJobQueue();
