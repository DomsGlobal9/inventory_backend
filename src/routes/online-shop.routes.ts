import { Router, Request, Response, NextFunction } from 'express';
import { onlineShop, shopBanners, shopInterest, OnlineShopRuleError } from '../services/online-shop';
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

// ── Banners ───────────────────────────────────────────────────────────────────────────────
// What a shop puts across the top of its own shop: a picture, a few words, and where tapping goes.

const userId = (req: Request) => ((req as any).user?.id as string) ?? null;

/**
 * Who is waiting for a piece that was sold out when they wanted it.
 *
 * Under this file's `admin:online_shop` like everything else here -- it is a list of customers'
 * phone numbers, which is not something every till login should be able to read. Anything that
 * shows it must cope with being refused rather than showing an error to somebody who simply
 * does not have the permission.
 */
router.get('/waiting', handle(req => shopInterest.whoIsWaiting(clientId(req), {
  productId: typeof req.query.productId === 'string' ? req.query.productId : undefined,
  includeHandled: req.query.all === '1'
})));

/** Dealt with. Kept rather than deleted, so the demand behind it is still countable. */
router.post('/waiting/:id/handled', handle(req => shopInterest.markHandled(clientId(req), String(req.params.id))));

router.get('/banners', handle(req => shopBanners.listFor(clientId(req))));
router.post('/banners', handle(req => shopBanners.add(clientId(req), userId(req), req.body ?? {})));
router.patch('/banners/order', handle(req => shopBanners.reorder(clientId(req), req.body?.ids)));
router.patch('/banners/:id', handle(req => shopBanners.edit(clientId(req), String(req.params.id), req.body ?? {})));
router.delete('/banners/:id', handle(req => shopBanners.remove(clientId(req), String(req.params.id))));

export default router;
