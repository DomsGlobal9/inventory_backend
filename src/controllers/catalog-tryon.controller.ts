import { Request, Response, NextFunction } from 'express';
import { catalogTryOnService } from '../services/catalog-tryon.service';

export class CatalogTryOnController {

  async generateCatalog(req: Request, res: Response, next: NextFunction) {
    const clientId = (req as any).clientId as string;
    const abortController = new AbortController();

    // If the browser disconnects (user navigates away / hits Stop without waiting
    // for cancel-job to round-trip), stop the upstream fetch immediately instead of
    // leaving it running against our Gateway quota.
    req.on('close', () => abortController.abort());

    try {
      const upstream = await catalogTryOnService.streamGenerateCatalog(
        { ...req.body, clientId },
        abortController.signal
      );

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        res.status(upstream.status || 502).json({ success: false, message: text || 'Try-On generation failed to start' });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        res.end();
        return;
      }
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
