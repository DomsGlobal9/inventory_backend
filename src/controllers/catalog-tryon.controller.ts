import { Request, Response, NextFunction } from 'express';
import { catalogTryOnService } from '../services/tryon';
import { tryOnUsageService } from '../services/tryon';
import { respondWithError } from '../utils/respondWithError';

export class CatalogTryOnController {

  async generateCatalog(req: Request, res: Response, next: NextFunction) {
    const clientId = (req as any).clientId as string;
    const abortController = new AbortController();

    // Whether the browser went away rather than the work finishing. Read after the loop, where
    // "the stream ended" alone cannot tell the two apart.
    let clientDisconnected = false;

    // If the browser disconnects (user navigates away / hits Stop without waiting
    // for cancel-job to round-trip), stop the upstream fetch immediately instead of
    // leaving it running against our Gateway quota.
    //
    // Watched on the RESPONSE, not the request. `req` emits 'close' as soon as its body has
    // been read -- which express.json() does before this handler even runs -- so listening
    // there aborted every single generation before the call to the gateway was made, and
    // returned an empty 200 that looked like a success. `res` closes either because we
    // finished writing it or because the socket went away, and writableFinished is what
    // tells those two apart.
    res.on('close', () => {
      if (res.writableFinished) return;
      clientDisconnected = true;
      abortController.abort();
    });

    try {
      // Checked before anything is started, so a client out of allowance is told rather than
      // charged. No limit set means no limit -- this must not switch off try-on for every
      // existing shop on the day it deploys.
      await tryOnUsageService.assertWithinLimit(clientId);

      const upstream = await catalogTryOnService.streamGenerateCatalog(
        { ...req.body, clientId },
        abortController.signal,
        // Passed separately from the payload as well, because it now decides which key we
        // present -- not just what we tell the far end we are doing.
        clientId
      );

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        // Started and refused. Recorded as a failure rather than ignored, because a client
        // whose key is wrong would otherwise show zero usage while nothing works for them --
        // and "no usage" and "broken" look identical in that case.
        void tryOnUsageService.record(clientId, { started: true, failed: true });
        res.status(upstream.status || 502).json({ success: false, message: text || 'Try-On generation failed to start' });
        return;
      }

      void tryOnUsageService.record(clientId, { started: true });

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');

      // Counted by watching the stream go past, not by trusting it to announce a total. Every
      // chunk is forwarded byte for byte first; the counting happens on a copy of the decoded
      // text and cannot alter, delay or break what the browser receives.
      let views = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        // Deliberately not a JSON parse of the whole event: the try-on service owns that shape
        // and it is not ours to depend on. Counting occurrences of an image URL appearing is a
        // weaker signal that survives the far end changing its field names, and if it ever
        // counts nothing the figure is zero rather than wrong.
        const matches = chunk.match(/"(?:imageUrl|image_url|url)"\s*:/g);
        if (matches) views += matches.length;
      }

      // Reached the end of the stream. If the browser had gone, this is a cancellation, not a
      // completed generation -- and the difference is the one the merchant would argue about.
      void tryOnUsageService.record(clientId, clientDisconnected
        ? { cancelled: true }
        : { completed: true, viewsGenerated: views });

      res.end();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        void tryOnUsageService.record(clientId, { cancelled: true });
        res.end();
        return;
      }

      // Checked BEFORE recording a failure, deliberately. A limit refusal is raised before
      // anything is sent anywhere, so counting it would charge a generation against a client
      // who was just told they had none left -- and push them further past a limit they cannot
      // get back under. It is a 429 with a message they can act on, not a 500.
      if (error?.statusCode === 429) {
        return respondWithError(res, error, { status: 429 });
        return;
      }

      // Anything else broke partway. Recorded, because the GPU time was spent whether or not
      // anything usable came out of it.
      void tryOnUsageService.record(clientId, { failed: true });
      next(error);
    }
  }

  async cancelJob(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const result = await catalogTryOnService.cancelJob(clientId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const catalogTryOnController = new CatalogTryOnController();
