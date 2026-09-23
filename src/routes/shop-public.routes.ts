import express, { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { onlineShop, shopCheckout, shopOtp, shopTryOn, OnlineShopRuleError } from '../services/online-shop';

/**
 * What a shopper's browser asks for at `shop.scaleezy.com/<slug>`.
 *
 * Public: no session, no credential, nobody signed in. So everything here is read-only, answers
 * only from what the shop chose to publish, and is addressed by slug -- a caller cannot name a
 * client id, which is why one shop's address can never reach another shop's stock.
 *
 * Mounted before the signed-in gate, like the storefront and short-link routes.
 */

const router = Router();

/**
 * A shopper browsing taps quickly -- a category, a filter, the next page -- so this is generous.
 * It is here to stop a scraper pulling a whole catalogue in a loop, not to slow a person down.
 */
/*
 * Settable, the same way the app's own limiter is (middleware/rate-limiter.middleware.ts), so a
 * test server can run a whole shop's worth of traffic in a few seconds without tripping it.
 */
const relaxed = Number(process.env.RATE_LIMIT_MAX) > 0;

const browseLimiter = rateLimit({
  windowMs: 60_000,
  max: relaxed ? 2000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests just now. Please wait a moment.' }
});

router.use(browseLimiter);

/*
 * The body parser belongs to this router, not to whoever mounts it.
 *
 * These routes are mounted twice -- at /shop on the API host and at /_api/shop on the shop host --
 * and both are ahead of the app's own express.json(). Put here, neither mount can forget it and
 * leave a checkout quietly reading an empty body.
 *
 * 32kb: the largest thing a shopper ever sends is twenty lines and an address. A checkout open to
 * the whole internet has no reason to accept a megabyte.
 */
router.use(express.json({ limit: '32kb' }));

/** Nothing here may be cached by a shared cache with another shop's answer. */
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * Ordering is not browsing.
 *
 * Pricing a bag runs the whole offers engine over the shop's catalogue, and placing an order holds
 * real stock. So these are counted separately and much more tightly than looking at pages -- a
 * person buying does this a handful of times, and anything doing it hundreds of times a minute is
 * not a person buying.
 */
const buyLimiter = rateLimit({
  windowMs: 60_000,
  max: relaxed ? 2000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts just now. Please wait a moment and try again.' }
});

/** A rule the shopper can do something about reads as a sentence, not as a crash. */
const buying = (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (e) {
      if (e instanceof OnlineShopRuleError) return res.status(400).json({ success: false, message: e.message });
      console.error('[shop] something went wrong while buying:', e);
      res.status(500).json({ success: false, message: 'Something went wrong at the shop. Please try again.' });
    }
  };

const notOpen = (res: Response, state: 'UNKNOWN' | 'CLOSED', name?: string) =>
  state === 'CLOSED'
    ? res.status(503).json({ success: false, state, message: `${name ?? 'This shop'} is not open just now.` })
    : res.status(404).json({ success: false, state, message: 'There is no shop at this address.' });

/** The shop itself: who it is, what it looks like, and the seller details the law requires. */
router.get('/:slug', async (req: Request, res: Response) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') return notOpen(res, shop.state, (shop as { name?: string }).name);
  // clientId is how this module finds the stock; it is not a shopper's business.
  const { clientId, locationIds, ...visible } = shop;
  res.json({ success: true, data: visible });
});

/** The catalogue, a page at a time. */
router.get('/:slug/products', async (req: Request, res: Response) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') return notOpen(res, shop.state, (shop as { name?: string }).name);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  const page = await onlineShop.publicProducts(shop, {
    q: str(req.query.q),
    category: str(req.query.category),
    fabric: str(req.query.fabric),
    dressType: str(req.query.dressType),
    minPrice: num(req.query.minPrice),
    maxPrice: num(req.query.maxPrice),
    sort: str(req.query.sort),
    page: num(req.query.page),
    limit: num(req.query.limit)
  });
  res.json({ success: true, data: page });
});

/** One product's page. */
router.get('/:slug/products/:productCode', async (req: Request, res: Response) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') return notOpen(res, shop.state, (shop as { name?: string }).name);
  const product = await onlineShop.publicProduct(shop, req.params.productCode);
  if (!product) return res.status(404).json({ success: false, message: 'That item is no longer in this shop.' });
  res.json({ success: true, data: product });
});

/*
 * ── Buying ────────────────────────────────────────────────────────────────────────────────
 *
 * The bag itself lives in the shopper's own browser, not here. There is no account to attach it
 * to, and a basket saved on a server for everyone who ever looked at a shop is a table that only
 * ever grows. What the server does is price it -- with the shop's own prices and the shop's own
 * offers -- and, when the customer says so, turn it into a real order.
 */

/** Price what is in the bag. Kept nowhere: the price an order is written against is made below. */
router.post('/:slug/bag', buyLimiter, buying(async (req) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') throw new OnlineShopRuleError('This shop is not open just now.');
  return shopCheckout.priceBag(shop.clientId, req.body?.lines, req.body?.couponCodes);
}));

/** Place the order. */
router.post('/:slug/orders', buyLimiter, buying(async (req) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') throw new OnlineShopRuleError('This shop is not open just now.');
  return shopCheckout.place(shop.clientId, req.body ?? {});
}));

/**
 * One order, for the customer holding its link.
 *
 * The token is the whole of the permission, which is why it is 24 random bytes rather than an
 * order number somebody could count upwards from.
 */
router.get('/:slug/orders/:token', buyLimiter, buying(async (req) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') throw new OnlineShopRuleError('This shop is not open just now.');
  return shopCheckout.summary(shop.clientId, req.params.token);
}));

/** The customer calling their own order off, while it is still sitting at the shop. */
router.post('/:slug/orders/:token/cancel', buyLimiter, buying(async (req) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') throw new OnlineShopRuleError('This shop is not open just now.');
  return shopCheckout.cancel(shop.clientId, req.params.token);
}));

/*
 * ── Seeing it on you ───────────────────────────────────────────────────────────────────
 *
 * A try-on is GPU time that the SHOP pays for, so this is counted far more tightly than anything
 * else here -- enough for somebody to try a few photographs and change their mind, nowhere near
 * enough for one address to spend a shop's month in an afternoon. The same sizing the in-shop
 * try-on uses, for the same reason.
 */
const tryOnLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: relaxed ? 2000 : 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'That is a lot of try-ons in a short time. Please wait a few minutes.' }
});

router.post('/:slug/products/:productCode/tryon', tryOnLimiter, buying(async (req) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') throw new OnlineShopRuleError('This shop is not open just now.');
  return shopTryOn.seeItOn(shop.clientId, req.params.productCode, req.body?.photo);
}));

/*
 * ── Proving a phone number ─────────────────────────────────────────────────────────────
 *
 * Counted far more tightly than anything else here, and per number as well as per caller: a code
 * goes to somebody else's phone, so this must never become a way to ring a stranger. The per-number
 * cap lives in the service, which is the only place that knows how many have already gone.
 */
const codeLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: relaxed ? 2000 : 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts just now. Wait a few minutes and try again.' }
});

router.post('/:slug/verify/send', codeLimiter, buying(async (req) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') throw new OnlineShopRuleError('This shop is not open just now.');
  return shopOtp.sendCode(shop.clientId, req.body?.phone);
}));

router.post('/:slug/verify/check', codeLimiter, buying(async (req) => {
  const shop = await onlineShop.publicShop(req.params.slug);
  if (shop.state !== 'OPEN') throw new OnlineShopRuleError('This shop is not open just now.');
  return shopOtp.checkCode(shop.clientId, req.body?.phone, req.body?.code);
}));

export default router;
