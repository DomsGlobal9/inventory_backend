import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { holdsEverything } from '../config/permissions';
import { linkState, makeLinkCode, unlink } from '../services/boutique';

/**
 * The shop owner's side of linking a boutique (PLAN-boutique-sync.md), for a client with retail AND a boutique:
 *
 *   GET    /api/v1/boutique-link        is a boutique linked, and which
 *   POST   /api/v1/boutique-link/code   a one-time code (30 minutes) to type into the boutique
 *   DELETE /api/v1/boutique-link        unlink: the boutique can no longer read or change this shop
 *
 * Owner only: linking hands the boutique this shop's products and stock.
 */
const router = Router();
router.use(tenantMiddleware);
const ownerOnly = (req: Request, res: Response, next: NextFunction) => {
  const u = (req as any).user;
  if (!u?.id) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  if (!holdsEverything(u.permissions, u.roles)) return res.status(403).json({ success: false, message: 'Only the account owner can link or unlink a boutique.' });
  next();
};
const clientOf = (req: Request) => (req as any).clientId as string;
const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error: any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

router.get('/', ownerOnly, handle(req => linkState(clientOf(req))));
router.post('/code', ownerOnly, handle(req => makeLinkCode(clientOf(req), String((req as any).user?.id ?? ''))));
router.delete('/', ownerOnly, handle(req => unlink(clientOf(req))));

export default router;
