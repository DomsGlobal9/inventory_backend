import { Router, Request, Response, NextFunction } from 'express';
import { onlineShop, OnlineShopRuleError } from '../services/online-shop';
import { requirePermission } from '../middleware/permission.middleware';

/**
 * Settings -> Online shop: the owner's side. The shopper's side is shop-public.routes.ts, which is
 * mounted before the signed-in gate and shares nothing with this file but the service beneath.
 *
 * Every route needs `admin:online_shop`, because everything here decides what the public can see.
 */
const router = Router();

const clientId = (req: Request) => (req as any).user.clientId as string;

const handle = (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (e) {
      // A rule the owner broke is something to read and fix, not a crash to report.
      if (e instanceof OnlineShopRuleError) return res.status(400).json({ success: false, message: e.message });
      next(e);
    }
  };

router.use(requirePermission('admin:online_shop'));

router.get('/', handle(req => onlineShop.settingsFor(clientId(req))));

/** Claim the web address, or change one that has never been open. */
router.post('/address', handle(req => onlineShop.chooseSlug(clientId(req), req.body?.slug)));

router.patch('/', handle(req => onlineShop.save(clientId(req), req.body ?? {})));

/** Open the shop to customers, or close it again. */
router.post('/open', handle(req => onlineShop.setLive(clientId(req), true)));
router.post('/close', handle(req => onlineShop.setLive(clientId(req), false)));

export default router;
