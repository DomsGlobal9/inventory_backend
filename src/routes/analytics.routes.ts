import { Router, Request, Response } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { respondWithError } from '../utils/respondWithError';
import { salesPage, stockValuePage, stockOnHandPage, runningLowPage } from '../services/analytics';

/**
 * The full pages behind the dashboard cards (services/analytics). Only the owner holds these keys until the
 * owner gives them to a role on the roles screen.
 */
const router = Router();
router.use(tenantMiddleware);

const page = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (e: any) {
    if (e?.statusCode && e.statusCode < 500) return res.status(e.statusCode).json({ success: false, message: e.message });
    return respondWithError(res, e, { status: 500, message: 'These figures could not be worked out just now. Please try again.' });
  }
};
const clientOf = (req: Request) => (req as any).clientId as string;

router.get('/sales', requirePermission('analytics:sales'), page(req => salesPage(clientOf(req), req.query as any)));
router.get('/stock-value', requirePermission('analytics:stock_value'), page(req => stockValuePage(clientOf(req))));
router.get('/stock-on-hand', requirePermission('analytics:stock'), page(req => stockOnHandPage(clientOf(req), req.query as any)));
router.get('/running-low', requirePermission('analytics:stock'), page(req => runningLowPage(clientOf(req), req.query as any)));

export default router;
