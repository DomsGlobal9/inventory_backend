import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { onlineShop } from '../services/online-shop';

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
const browseLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests just now. Please wait a moment.' }
});

router.use(browseLimiter);

/** Nothing here may be cached by a shared cache with another shop's answer. */
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

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
  const page = await onlineShop.publicProducts(shop, {
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    limit: Number(req.query.limit) || undefined
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

export default router;
