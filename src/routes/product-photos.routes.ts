import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import * as productPhotos from '../services/product-photos';

/**
 * Photos for many products at once. Its own path, not under /products, where /:id would take
 * "photos" for a product id. Adding photos changes the product, so product:update -- the same as
 * the product page's own Upload button.
 */
const router = Router();

router.use(tenantMiddleware);

const handle = (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (error: any) {
      if (error?.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
      next(error);
    }
  };

router.post('/match', requirePermission('product:update'), handle(req =>
  productPhotos.match((req as any).clientId, req.body?.names)));

router.get('/find', requirePermission('product:update'), handle(req =>
  productPhotos.find((req as any).clientId, req.query.q)));

router.post('/from-link', requirePermission('product:update'), handle(req =>
  productPhotos.fromLink((req as any).clientId, req.body ?? {})));

export default router;
