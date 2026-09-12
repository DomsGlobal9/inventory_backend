import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { authenticateStorefront, storefrontContext, StorefrontContext } from '../middleware/storefront.middleware';
import { storefrontCatalogueService } from '../services/storefront-catalogue.service';
import { pricingQuoteService } from '../services/pricing';
import { respondWithError } from '../utils/respondWithError';

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
 *
 * And two more that are the whole POINT of the Offers project:
 *
 *   GET /offers                   what to put a badge on, before anybody has a basket
 *   POST /pricing/quote           what this basket costs -- the same question the till asks,
 *                                 answered by the same engine
 *
 * The website never implements a discount rule. It cannot: it is not told what they are, only
 * what they come to. That is deliberate -- a rule implemented twice is a rule implemented
 * differently, and the difference is a customer charged a price the shop never agreed to.
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

/**
 * Tighter, because a quote WRITES a row.
 *
 * The read endpoints above can be hammered during a sync and cost nothing but a query. Pricing
 * a basket keeps the answer for fifteen minutes, so a storefront re-pricing on every keystroke
 * of a quantity box would fill a table with baskets nobody ever bought. One a second is far
 * more than a real checkout needs.
 */
const quoteLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many pricing requests. Slow down and retry shortly.' }
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

/**
 * Which of our locations this storefront sells from.
 *
 * Pricing needs ONE location: a variant can be priced differently at the shop and at the
 * warehouse (VariantLocationProfile.priceOverride), and an offer can be limited to one of them.
 * The catalogue endpoints can quote the lowest price across a scope because they are only
 * describing; a quote is a promise, and a promise needs a definite answer.
 *
 * So: what the caller said, if it is inside the connection's scope. Failing that, the one
 * location the connection has. Only when neither is true does it ask -- and it asks by name,
 * with the list, rather than refusing with "locationCode required".
 */
async function sellingLocation(
  ctx: StorefrontContext,
  requestedCode: string | undefined
): Promise<{ id: string } | { error: string }> {
  const scoped = await prisma.stockLocation.findMany({
    where: {
      clientId: ctx.clientId,
      active: true,
      ...(ctx.locationIds.length > 0 ? { id: { in: ctx.locationIds } } : {})
    },
    select: { id: true, code: true, name: true }
  });

  if (scoped.length === 0) {
    return { error: 'This storefront has no location to sell from. Ask the shop owner to set one.' };
  }

  if (requestedCode) {
    const match = scoped.find(l => l.code.toLowerCase() === requestedCode.toLowerCase());
    if (!match) {
      return {
        error:
          `This storefront cannot sell from ${requestedCode}. ` +
          `It sells from: ${scoped.map(l => l.code).join(', ')}.`
      };
    }
    return { id: match.id };
  }

  if (scoped.length === 1) return { id: scoped[0].id };

  return {
    error:
      `Say which location this is selling from: ${scoped.map(l => l.code).join(', ')}.`
  };
}

/**
 * Offers a shopper could see advertised.
 *
 * For the badge on a listing page -- "20% off" under a saree, before there is a basket. Calling
 * the quote endpoint once per tile to discover that would be absurd and would write a quote row
 * per tile.
 *
 * Codes are NOT listed here; see pricing/quote.service.publicOffers for why.
 */
router.get('/offers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const location = await sellingLocation(
      ctx, req.query.locationCode ? String(req.query.locationCode) : undefined
    );
    if ('error' in location) {
      res.status(400).json({ success: false, message: location.error });
      return;
    }

    const offers = await pricingQuoteService.publicOffers(ctx.clientId, 'ONLINE', location.id);
    res.json({ success: true, data: { offers } });
  } catch (error) { next(error); }
});

/**
 * What does this basket cost?
 *
 * The same engine the till uses, reached through a different door. A storefront speaks in the
 * codes it was given -- variantCode, locationCode -- never in our internal ids, which it has
 * never seen and could not match to anything it holds.
 *
 * A POST because it CREATES something: the answer is kept for fifteen minutes and the order
 * that follows is held to it. Send `quoteId` back with the order and the customer is charged
 * what they were shown, whatever has happened to the offers in between.
 */
router.post('/pricing/quote', quoteLimiter, async (req: Request, res: Response) => {
  try {
    const ctx = storefrontContext(req, res);
    if (!ctx) return;

    const location = await sellingLocation(
      ctx, req.body?.locationCode ? String(req.body.locationCode) : undefined
    );
    if ('error' in location) {
      return res.status(400).json({ success: false, message: location.error });
    }

    const incoming = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (incoming.length === 0) {
      return res.status(400).json({ success: false, message: 'There is nothing in this basket.' });
    }

    /*
     * Codes to ids, in ONE query.
     *
     * A lookup per line would be a basket of thirty items costing thirty round trips, and a
     * storefront pricing a basket on every quantity change would feel every one of them.
     */
    const codes: string[] = [...new Set<string>(incoming.map((l: any) => String(l.variantCode ?? '')).filter(Boolean))];
    const variants = codes.length
      ? await prisma.productVariant.findMany({
          where: { clientId: ctx.clientId, variantCode: { in: codes } },
          select: { id: true, variantCode: true }
        })
      : [];
    const idFor = new Map(variants.map(v => [v.variantCode, v.id]));

    const lines: { variantId: string; quantity: number }[] = [];
    for (const line of incoming) {
      const code = String(line?.variantCode ?? '');
      if (!code) {
        return res.status(400).json({
          success: false,
          message: 'Every line needs a variantCode -- the code this item has in the catalogue.'
        });
      }
      const variantId = idFor.get(code);
      if (!variantId) {
        // The code, not our id, because the code is the only half of this the caller knows.
        return res.status(404).json({
          success: false,
          message: `No item here matches ${code}.`
        });
      }
      lines.push({ variantId, quantity: Number(line.quantity) });
    }

    /*
     * The shopper, if we already know them.
     *
     * Only used for per-customer limits ("one per customer"), and never created here: pricing a
     * basket must not quietly write a customer record for somebody who then does not buy. An
     * unknown shopper is simply a guest, and an offer limited per customer is withheld from a
     * guest rather than given away without limit.
     */
    let customerId: string | null = null;
    if (req.body?.customerExternalId) {
      const customer = await prisma.customer.findFirst({
        where: { clientId: ctx.clientId, externalCustomerId: String(req.body.customerExternalId) },
        select: { id: true }
      });
      customerId = customer?.id ?? null;
    }

    const quote = await pricingQuoteService.quote(ctx.clientId, {
      locationId: location.id,
      channel: 'ONLINE',
      customerId,
      couponCodes: Array.isArray(req.body?.couponCodes) ? req.body.couponCodes : [],
      lines
    });

    res.json({ success: true, data: quote });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not price that basket.' });
  }
});

export default router;
