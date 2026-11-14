import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { linkState } from '../services/boutique';

/**
 * The shop's own view of its boutique (PLAN-boutique-sync.md): GET /api/v1/boutique-link → which boutique, if any,
 * uses this shop's products and stock. Turning the Boutique module on or off is ScaleEzy's job, from the Platform
 * Console (/api/v1/admin/clients/:clientId/boutique), so a shop has nothing to change here.
 */
const router = Router();
router.use(tenantMiddleware);
const clientOf = (req: Request) => (req as any).clientId as string;

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await linkState(clientOf(req)) }); }
  catch (error) { next(error); }
});

export default router;
