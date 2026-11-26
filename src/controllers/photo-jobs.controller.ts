import { Request, Response, NextFunction } from 'express';
import { photoJobQueue } from '../services/photo-jobs';
import { catalogTryOnService, jobKeyFor } from '../services/tryon';
import { respondWithError } from '../utils/respondWithError';
import { prisma } from '../lib/prisma';
import { safeMessage } from '../lib/safeMessage';
import { resolveTryOnCategory, makesProductShots } from '../services/photo-jobs';

/**
 * The photographs a shop has asked for: start them, watch them, stop them, clear the notice.
 *
 * Every one of these answers immediately. Nothing here waits for a generation -- that is the
 * whole change. Starting four colours is four rows written and a list handed back; the shop is
 * free to go and do something else before the first one has begun.
 */
export class PhotoJobsController {

  /**
   * Start making photographs.
   *
   * Answers with what was queued AND what was not, because partial success is a real outcome:
   * three colours started and one refused because its sizes were deleted a minute ago is better
   * than refusing all four and leaving the shop to work out which one was the problem.
   */
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const userId = (req as any).user?.id as string | undefined;
      const { productId, kind, colours, sourceImageId, extraSourceImageIds } = (req.body ?? {}) as Record<string, any>;

      if (!productId) return respondWithError(res, { statusCode: 400, message: 'Which product? None was given.' }, { status: 400 });
      if (kind !== 'VIEWS' && kind !== 'COLOUR' && kind !== 'SHOTS') {
        return respondWithError(res, { statusCode: 400, message: 'That is not a kind of photograph we make.' }, { status: 400 });
      }

      const result = await photoJobQueue.enqueue({
        clientId,
        productId,
        kind,
        colours: Array.isArray(colours) ? colours : [colours],
        sourceImageId: sourceImageId ?? null,
        // Left out: the colour's other own photos go by themselves. A list: exactly those (an empty list: none).
        extraSourceImageIds: Array.isArray(extraSourceImageIds) ? extraSourceImageIds.filter((x: unknown) => typeof x === 'string') : null,
        requestedBy: userId ?? null
      });

      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /photo-jobs/product-shots { productIds }: the 3 product photos for many sarees at once (old sarees that already
   * have their views; 26 Nov 2026). One SHOTS job per colour that has the shop's own photo; the views are kept. Not
   * charged by the studio. Each product answers for itself: made, or why not.
   */
  async productShots(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const userId = (req as any).user?.id as string | undefined;
      const ids = Array.isArray(req.body?.productIds) ? [...new Set((req.body.productIds as unknown[]).filter((x): x is string => typeof x === 'string'))] : [];
      if (!ids.length) return respondWithError(res, { statusCode: 400, message: 'Choose at least one saree.' }, { status: 400 });
      if (ids.length > 100) return respondWithError(res, { statusCode: 400, message: 'Choose at most 100 sarees at a time.' }, { status: 400 });
      const products = await prisma.product.findMany({
        where: { id: { in: ids }, clientId, trashedAt: null },
        select: { id: true, title: true, dressType: true, variants: { select: { colorName: true } } }
      });
      const results: { productId: string; title: string | null; made: number; refused: { colour: string; why: string }[] }[] = [];
      for (const id of ids) {
        const p = products.find(x => x.id === id);
        if (!p) { results.push({ productId: id, title: null, made: 0, refused: [{ colour: '', why: 'That product is not in your shop, or it is in the bin.' }] }); continue; }
        if (!makesProductShots(resolveTryOnCategory(p.dressType))) { results.push({ productId: id, title: p.title, made: 0, refused: [{ colour: '', why: 'Product photos are made for sarees only.' }] }); continue; }
        const colours = [...new Set(p.variants.map(v => v.colorName).filter((c): c is string => !!c))];
        try {
          const r = await photoJobQueue.enqueue({ clientId, productId: id, kind: 'SHOTS', colours, requestedBy: userId ?? null });
          results.push({ productId: id, title: p.title, made: r.made.length, refused: r.refused });
        } catch (e: any) {
          // Our own refusals are written for the shop; anything else (a database hiccup) is not repeated.
          results.push({ productId: id, title: p.title, made: 0, refused: [{ colour: '', why: e?.statusCode && e.statusCode < 500 ? safeMessage(e?.message, 'It could not be started.') : 'It could not be started just now. Please try again.' }] });
        }
      }
      res.status(200).json({ success: true, data: { made: results.reduce((t, r) => t + r.made, 0), results } });
    } catch (error) {
      next(error);
    }
  }

  /** What is happening now, and what happened recently, for one product's Images tab. */
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;

      const [active, recent] = await Promise.all([
        photoJobQueue.active(clientId, productId),
        productId ? photoJobQueue.forProduct(clientId, productId) : Promise.resolve([])
      ]);

      res.status(200).json({ success: true, data: { active, recent } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Finished, and nobody has been told.
   *
   * This is the notice itself. It is asked for from anywhere in the app, which is what makes
   * "press it and go and do something else" actually work -- the answer finds them on whatever
   * screen they happen to be on, or the next time they sign in.
   */
  async notices(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const unseen = await photoJobQueue.unseen(clientId);
      res.status(200).json({ success: true, data: { unseen } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Stop one.
   *
   * Two things happen, and both are needed. The row is flagged, which is how the request reaches
   * a runner that may be on another instance; and the photo studio is told directly, which is
   * what actually ends the stream rather than waiting up to ten seconds for the flag to be read.
   *
   * The studio being unreachable does not fail the cancel. The flag alone still stops it, a few
   * seconds later -- and a shop that pressed Stop should not be shown an error about it.
   */
  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const job = await photoJobQueue.cancel(clientId, String(req.params.id));

      if (job.status === 'RUNNING' || job.cancelRequested) {
        await catalogTryOnService
          .cancelJob(clientId, jobKeyFor(clientId, job.jobKey))
          .catch(err => console.warn(`[photo-jobs] telling the studio to stop ${job.id} failed:`, err?.message));
      }

      res.status(200).json({ success: true, data: job });
    } catch (error) {
      next(error);
    }
  }

  /** Marks notices as told -- all of them, or just the ones named. */
  async seen(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((i: any) => typeof i === 'string') : undefined;
      res.status(200).json({ success: true, data: await photoJobQueue.markSeen(clientId, ids) });
    } catch (error) {
      next(error);
    }
  }
}

export const photoJobsController = new PhotoJobsController();
