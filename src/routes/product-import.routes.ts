import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { productImportService, ImportRow } from '../services/product-import.service';

const router = Router();

router.use(tenantMiddleware);

const ctx = (req: Request) => ({
  clientId: (req as any).clientId as string,
  held: ((req as any).user?.permissions || []) as string[],
  userId: (req as any).user?.id as string | undefined
});

const rowsOf = (req: Request): ImportRow[] => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows)) throw { statusCode: 400, message: 'No rows were sent.' };
  return rows;
};

const handle = (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (error: any) {
      if (error?.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
      next(error);
    }
  };

/**
 * Both routes are gated on product:view, not on product:create.
 *
 * The finer-grained question -- may THIS file create products, set prices, set costs -- is
 * answered per column inside the service, against the rows actually supplied, and refuses
 * the whole file with a reason naming what it was. Gating the route on product:create
 * instead would mean somebody who may only update prices could not preview a price file.
 */
router.post('/validate', requirePermission('product:view'), handle(req => {
  const { clientId, held } = ctx(req);
  return productImportService.plan(clientId, rowsOf(req), held);
}));

router.post('/apply', requirePermission('product:view'), handle(req => {
  const { clientId, held, userId } = ctx(req);
  const fingerprint = String(req.body?.fingerprint || '');
  if (!fingerprint) {
    // Without this an apply could be the first time these rows were ever examined, which
    // is the one thing the preview exists to prevent.
    throw { statusCode: 400, message: 'Preview the file before importing it.' };
  }
  return productImportService.apply(clientId, rowsOf(req), held, userId, fingerprint);
}));

export default router;
