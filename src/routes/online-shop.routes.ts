import { Router, Request, Response, NextFunction } from 'express';
import { onlineShop, shopBanners, shopIcon, shopInterest, OnlineShopRuleError } from '../services/online-shop';
import { requirePermission } from '../middleware/permission.middleware';
import { holdsEverything } from '../config/permissions';
import { paymentAccounts } from '../services/payments/account.service';
import { GatewayError } from '../services/payments/gateway';
import * as onlinePayments from '../services/payments/online-payment.service';
import { requirePermission as can } from '../middleware/permission.middleware';

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

/*
 * The square picture the browser puts in its tab. Its own pair of routes rather than a field on
 * PATCH /, because it carries a whole picture: the settings save is a small JSON body somebody
 * presses Save on, and folding a base64 photograph into it would make every ordinary save large.
 */
router.post('/icon', handle(req => shopIcon.setIcon(clientId(req), req.body ?? {})));
router.delete('/icon', handle(req => shopIcon.clearIcon(clientId(req))));

// ── Payments ──────────────────────────────────────────────────────────────────────────────
// The shop connects its OWN Razorpay account (PLAN-online-shop-payments.md). Reading how it is
// set up needs admin:online_shop like the rest of this file; changing where the money goes needs
// the account owner.

/** This API's own address, for the webhook URL the owner pastes into Razorpay. */
const apiBase = (req: Request) =>
  (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/**
 * Only the account owner changes where a customer's money lands. requireAccountOwner asks the same
 * question, but its refusal talks about the shop's name and logo; this one says what it is about.
 */
const ownerOnly = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user || !holdsEverything(user.permissions, user.roles)) {
    return res.status(403).json({ success: false, message: 'Only the account owner can connect or change the shop’s payment account.' });
  }
  next();
};

/** Reports a gateway that did not answer as a sentence, not a crash: the owner can try again. */
const paying = (fn: (req: Request) => Promise<unknown>) => handle(async (req) => {
  try { return await fn(req); } catch (e) {
    if (e instanceof GatewayError) throw new OnlineShopRuleError(e.message);
    throw e;
  }
});

router.get('/payments', handle(req => paymentAccounts.describe(clientId(req), apiBase(req))));
router.put('/payments', ownerOnly, paying(req => paymentAccounts.save(clientId(req), userId(req), req.body ?? {}, apiBase(req))));
router.post('/payments/check', paying(req => paymentAccounts.check(clientId(req), apiBase(req))));
router.post('/payments/webhook-secret', ownerOnly, handle(req => paymentAccounts.newWebhookSecret(clientId(req), apiBase(req))));
router.delete('/payments', ownerOnly, handle(req => paymentAccounts.remove(clientId(req), apiBase(req))));

/** What has been paid online lately, and what has gone back. */
router.get('/payments/activity', handle(req => onlinePayments.activity(clientId(req), Number(req.query.limit) || 30)));

/**
 * Money back to a customer who paid online -- all of it or part, e.g. for a return. Needs the
 * permission the till uses to pay money back. The money can only ever go back to the card or UPI
 * it came from; there is no way to send it anywhere else.
 */
router.post('/payments/refund', can('return:counter'), paying(req =>
  onlinePayments.refundByOwner(clientId(req), userId(req), req.body ?? {})));

router.get('/banners', handle(req => shopBanners.listFor(clientId(req))));
router.post('/banners', handle(req => shopBanners.add(clientId(req), userId(req), req.body ?? {})));
router.patch('/banners/order', handle(req => shopBanners.reorder(clientId(req), req.body?.ids)));
router.patch('/banners/:id', handle(req => shopBanners.edit(clientId(req), String(req.params.id), req.body ?? {})));
router.delete('/banners/:id', handle(req => shopBanners.remove(clientId(req), String(req.params.id))));

export default router;
