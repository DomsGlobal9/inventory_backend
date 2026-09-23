import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/permission.middleware';
import { wearIt, allowanceFor, TryOnWearError } from '../services/shopper-tryon/wear.service';

/**
 * Try-on at the counter.
 *
 * A customer is standing in front of a salesperson holding a saree, and asking the obvious
 * question. Until now the only answer this app had was a QR code on the tag: print it, hand them
 * the garment, hope they scan it, hope they have the app. That works for a customer browsing
 * alone; it is useless with somebody already at the counter.
 *
 * So: the same try-on, from the product screen, with the salesperson taking the photograph.
 *
 * SIGNED IN, and behind `product:view` -- whoever may look at a product's page may do this. It is
 * the shop's own staff spending the shop's own allowance on the shop's own customer, which is a
 * different question from the shopper-facing one and needs none of its anonymity.
 */
const router = Router();

/*
 * A try-on is GPU time the shop pays for. Sized for a salesperson working through a few pieces
 * with one customer -- generous enough not to interrupt a sale, nowhere near enough for a tab left
 * open on a counter to spend a month in an afternoon.
 */
const counterLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) > 0 ? 2000 : 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'That is a lot of try-ons in a short time. Please wait a few minutes.' }
});

// A photograph, not a document. Its own parser so the app's own 100kb default does not refuse one.
router.use(express.json({ limit: '15mb' }));

const clientId = (req: Request) => (req as any).user.clientId as string;

const handle = (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (e) {
      if (e instanceof TryOnWearError) return res.status(e.statusCode).json({ success: false, message: e.message });
      next(e);
    }
  };

/** What is left this month, so the screen can say so before anybody takes a photograph. */
router.get('/allowance', requirePermission('product:view'), handle(req => allowanceFor(clientId(req))));

/**
 * One try-on of one of this shop's products.
 *
 * The garment comes from the product's own row, never from the request. If the picture to wear
 * came from the body, this would be a way to have any shop pay to composite any two images.
 */
router.post('/:productId', requirePermission('product:view'), counterLimiter, handle(async (req) => {
  const client = clientId(req);
  const product = await prisma.product.findFirst({
    where: { id: String(req.params.productId), clientId: client, trashedAt: null },
    select: {
      title: true, dressType: true,
      images: {
        where: { imageType: { in: ['COVER', 'GALLERY'] } },
        select: { url: true, isPrimary: true },
        orderBy: { orderIndex: 'asc' }
      }
    }
  });
  if (!product) throw new TryOnWearError('That product was not found.', 404);

  /*
   * A specific photograph may be asked for -- the salesperson is looking at one of several and
   * means that one -- but only one of THIS product's own, checked against the row rather than
   * trusted. Otherwise it is the cover.
   */
  const asked = typeof req.body?.imageUrl === 'string' ? req.body.imageUrl : null;
  const garmentImageUrl = (asked && product.images.some(i => i.url === asked))
    ? asked
    : (product.images.find(i => i.isPrimary)?.url ?? product.images[0]?.url);

  if (!garmentImageUrl) {
    throw new TryOnWearError('This product has no photograph yet, so there is nothing to try on.');
  }

  return wearIt({
    clientId: client,
    garment: { imageUrl: garmentImageUrl, title: product.title, dressType: product.dressType },
    photoBase64: req.body?.photo,
    from: 'COUNTER'
  });
}));

export default router;
