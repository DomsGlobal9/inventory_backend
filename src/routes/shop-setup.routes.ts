import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { holdsEverything } from '../config/permissions';
import { getSetup, saveSetup } from '../services/shop-setup';

/**
 * "Set up your shop" (PLAN-onboarding-setup.md).
 *
 *   GET /api/v1/setup   what the shop sells and whether the owner finished the setup. Anyone signed in: every screen
 *                       shapes itself by it (a ready-made shop never sees metres).
 *   PUT /api/v1/setup   the owner's answers: what it sells, smallest cut, finish (details and GST: /branding).
 */
const router = Router();
router.use(tenantMiddleware);
const clientOf = (req: Request) => (req as any).clientId as string;
const ownerOnly = (req: Request, res: Response, next: NextFunction) => {
  const u = (req as any).user;
  if (!u?.id) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  if (!holdsEverything(u.permissions, u.roles)) return res.status(403).json({ success: false, message: 'Only the account owner can change this setting.' });
  next();
};
const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error: any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

router.get('/', handle(req => getSetup(clientOf(req))));
router.put('/', ownerOnly, handle(req => saveSetup(clientOf(req), req.body ?? {})));

export default router;
