import { prisma } from '../lib/prisma';
import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { fabricSettings, setFabricSettings } from '../services/fabrics';
import { KINDS, SELLING_NOW, UNITS } from '../lib/units';

/**
 * Settings → Products → Fabrics (13 Nov 2026, PLAN-fabrics.md).
 *
 *   GET /api/v1/fabrics   the shop's switch and defaults, plus the units and kinds to choose from (anyone who can see
 *                         products: the Add product screen needs them)
 *   PUT /api/v1/fabrics   change them (whoever manages sizes, colours and categories)
 */
const router = Router();
router.use(tenantMiddleware);
const clientOf = (req: Request) => (req as any).clientId as string;
const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error: any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

router.get('/', requirePermission('product:view'), handle(async req => ({
  ...(await fabricSettings(clientOf(req))),
  // What the shop sells shapes Add product (PLAN-onboarding-setup.md); null = not asked yet.
  sells: (await prisma.clientSettings.findUnique({ where: { clientId: clientOf(req) }, select: { sells: true } }))?.sells ?? null,
  units: SELLING_NOW.map(code => ({ code, ...UNITS[code] })),
  kinds: KINDS
})));

router.put('/', requirePermission('admin:catalog'), handle(req => setFabricSettings(clientOf(req), req.body ?? {})));

export default router;
