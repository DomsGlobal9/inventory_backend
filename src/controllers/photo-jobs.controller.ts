import { Request, Response, NextFunction } from 'express';
import { photoJobQueue } from '../services/photo-jobs';
import { catalogTryOnService, jobKeyFor } from '../services/tryon';
import { respondWithError } from '../utils/respondWithError';

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
      const { productId, kind, colours, sourceImageId } = (req.body ?? {}) as Record<string, any>;

      if (!productId) return respondWithError(res, { statusCode: 400, message: 'Which product? None was given.' }, { status: 400 });
      if (kind !== 'VIEWS' && kind !== 'COLOUR') {
        return respondWithError(res, { statusCode: 400, message: 'That is not a kind of photograph we make.' }, { status: 400 });
      }

      const result = await photoJobQueue.enqueue({
        clientId,
        productId,
        kind,
        colours: Array.isArray(colours) ? colours : [colours],
        sourceImageId: sourceImageId ?? null,
        requestedBy: userId ?? null
      });

      res.status(200).json({ success: true, data: result });
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
