import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { authenticateStorefront, storefrontContext } from '../middleware/storefront.middleware';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';

/**
 * The API a merchant's website calls.
 *
 * Mounted ahead of the human `authenticate` gate, because the caller is a website with a
 * connection credential, not a person with a session cookie. Everything below is read-only and
 * scoped by the credential: a storefront cannot change stock, cannot see another tenant, and
 * cannot see beyond the locations its connection was given.
 *
 * Three endpoints, which together are the whole synchronisation story:
 *
 *   GET /products                 initial sync, and -- with a cursor -- incremental sync
 *   GET /products/:code           one product, for filling a gap
 *   POST /sync/complete           the storefront says it has the catalogue; the connection
 *                                 goes ACTIVE and starts receiving events
 */

const router = Router();

/**
 * Generous, because a storefront legitimately pages hard during an initial sync -- 8,000
 * variants at 50 a page is 160 requests in quick succession -- but bounded, so a broken
 * integration in a retry loop cannot take the database down for everyone.
 */
const storefrontLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Slow down and retry shortly.' }
});

router.use(storefrontLimiter);
router.use(authenticateStorefront);

/** Who am I, and what am I scoped to. The first call any integrator makes. */
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const locations = await prisma.stockLocation.findMany({
      where: {
        clientId: ctx.clientId,
        ...(ctx.locationIds.length > 0 ? { id: { in: ctx.locationIds } } : {})
      },
      select: { id: true, code: true, name: true }
    });

    res.json({
      success: true,
      data: {
        connection: ctx.connectionName,
        status: ctx.status,
        currency: await storefrontCatalogueService.getCurrency(ctx.clientId),
        // Stated explicitly so an integrator can see which locations their stock figures come
        // from, rather than wondering why a number differs from the shop's own screen.
        locations: locations.map(l => ({ code: l.code, name: l.name })),
        stockSemantics: {
          quantity: 'units physically held across the locations above',
          reserved: 'units already promised to an order',
          available: 'quantity minus reserved',
          sellable: 'available is above zero and the item is marked available at a location'
        }
      }
    });
  } catch (error) { next(error); }
});

/**
 * The catalogue.
 *
 * With no cursor this is the initial sync. With one it is "everything after that point", which
 * is the same mechanism -- and why recovery is cheap: a storefront that missed thirty webhooks
 * asks from its last cursor rather than resyncing from scratch.
 *
 * `?since=` additionally filters by modification time, for a periodic reconciliation sweep.
 */
router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      res.status(400).json({ success: false, message: '`limit` must be a positive number.' });
      return;
    }

    let since: Date | undefined;
    if (req.query.since) {
      since = new Date(String(req.query.since));
      if (Number.isNaN(since.getTime())) {
        res.status(400).json({ success: false, message: '`since` must be an ISO 8601 timestamp.' });
        return;
      }
    }

    const page = await storefrontCatalogueService.listProducts(
      { clientId: ctx.clientId, locationIds: ctx.locationIds },
      { cursor: req.query.cursor ? String(req.query.cursor) : undefined, limit, since }
    );

    res.json({ success: true, data: page });
  } catch (error) { next(error); }
});

router.get('/products/:productCode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const product = await storefrontCatalogueService.getProduct(
      { clientId: ctx.clientId, locationIds: ctx.locationIds },
      String(req.params.productCode)
    );

    if (!product) {
      // Deliberately the same answer for "no such product" and "not published": whether a
      // merchant has an unpublished draft is not a storefront's business.
      res.status(404).json({ success: false, message: 'No published product with that code.' });
      return;
    }

    res.json({ success: true, data: product });
  } catch (error) { next(error); }
});

/**
 * The storefront reports that it has the catalogue.
 *
 * Until this is called the connection stays PENDING_SYNC and events queue rather than being
 * sent -- telling a website that a price changed before it has the product is noise it cannot
 * act on. Calling it flips the connection to ACTIVE and the queued events drain.
 *
 * The storefront declares this rather than us inferring it from pagination, because only the
 * storefront knows whether it actually stored what it fetched.
 */
router.post('/sync/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const cursor = req.body?.cursor ? String(req.body.cursor) : null;

    await prisma.storefrontConnection.update({
      where: { id: ctx.connectionId },
      data: { status: 'ACTIVE', syncedAt: new Date(), syncCursor: cursor }
    });

    res.json({
      success: true,
      data: { status: 'ACTIVE', message: 'Synchronised. Live updates will now be delivered.' }
    });
  } catch (error) { next(error); }
});

export default router;
