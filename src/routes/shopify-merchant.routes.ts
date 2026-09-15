import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import {
  shopifyInstallationService,
  ShopifyConfigurationError,
  ShopifyInstallError
} from '../services/shopify-installation.service';
import { shopifyInboxService } from '../services/shopify-orders';
import { shopifyPrivacyService } from '../services/shopify-privacy';
import {
  adminApiFor, activeInstallation,
  shopifyLocationPairingService, shopifyVariantMatchingService
} from '../services/shopify-mapping';
import { respondWithError } from '../utils/respondWithError';

/**
 * The merchant's side of Shopify: starting an install, and claiming one that started on
 * Shopify.
 *
 * Behind the normal session and the same admin permission as storefront connections, for the
 * same reason -- connecting a store hands an outside system a live read of the whole catalogue
 * and every stock level, which is not a shop-floor decision.
 *
 * Note what is NOT here: the token. It is never returned by any route, at any point, to any
 * caller. The frontend has no use for it and every path that exposes a replayable credential to
 * a browser is a path that eventually leaks one.
 */

const router = Router();
router.use(tenantMiddleware);

const PERMISSION = 'admin:locations';

const clientOf = (req: Request) => (req as any).clientId as string;
const userOf = (req: Request) => (req as any).user?.id as string | undefined;

function fail(res: Response, error: any, next: NextFunction) {
  if (error instanceof ShopifyConfigurationError) {
    return res.status(503).json({ success: false, message: error.message });
  }
  if (error instanceof ShopifyInstallError) {
    return res.status(400).json({ success: false, message: error.message });
  }
  return next(error);
}

/**
 * Step one of the install, started from inside ScaleEzy.
 *
 * Returns the URL rather than redirecting, because the caller is a fetch from the app, not a
 * browser navigation -- the frontend sends the merchant to Shopify itself. Doing the redirect
 * here would mean the app's own API call following a cross-origin redirect to Shopify, which
 * fails in a way that is hard to read.
 */
router.post('/install', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    const body = z.object({ shop: z.string().trim().min(1, 'Enter your Shopify store address') }).parse(req.body);
    const { shopDomain, authorizeUrl } = await shopifyInstallationService.beginInstall({
      shop: body.shop,
      clientId: clientOf(req),
      userId: userOf(req)
    });
    res.json({ success: true, data: { shopDomain, authorizeUrl } });
  } catch (error: any) {
    if (error?.issues) {
      return res.status(400).json({ success: false, message: error.issues[0]?.message ?? 'Invalid request' });
    }
    fail(res, error, next);
  }
});

/**
 * Installations sitting unclaimed, waiting for someone to say whose they are.
 *
 * Deliberately NOT filtered by tenant -- an unclaimed installation belongs to nobody yet, so
 * there is no tenant to filter by. What is returned is only the shop domain and when it
 * installed: enough to recognise your own store, and nothing about anyone's catalogue,
 * inventory or orders.
 */
router.get('/pending', requirePermission(PERMISSION), async (_req, res, next) => {
  try {
    const pending = await prisma.shopifyInstallation.findMany({
      where: { clientId: null, uninstalledAt: null },
      select: { shopDomain: true, installedAt: true },
      orderBy: { installedAt: 'desc' },
      take: 25
    });
    res.json({ success: true, data: pending });
  } catch (error) {
    next(error);
  }
});

/**
 * Claims one of those.
 *
 * The merchant types or confirms the shop domain, which is the whole safeguard: claiming binds
 * that store to this workspace, and binding the wrong one publishes this tenant's inventory to
 * somebody else's website. It is refused outright if the shop already belongs to another
 * workspace.
 */
router.post('/claim', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    const body = z.object({ shop: z.string().trim().min(1) }).parse(req.body);
    const installation = await shopifyInstallationService.claim(body.shop, clientOf(req), userOf(req));

    /*
     * Orders that arrived while the store belonged to nobody now have an owner.
     *
     * Attached and retried straight away. Most will park again for want of a location pairing --
     * a store claimed a minute ago has none yet -- but they now appear in this workspace's inbox
     * with that reason, instead of sitting unowned where no panel could ever show them.
     */
    const attached = await shopifyInboxService.attachClaimed(installation.shopDomain, clientOf(req));
    // A privacy request that arrived while the store was unclaimed is this workspace's to answer now.
    await shopifyPrivacyService.attachClaimed(installation.shopDomain, clientOf(req));
    const replay = attached > 0 ? await shopifyInboxService.replayAll(clientOf(req), userOf(req)) : null;

    res.json({ success: true, data: { ...installation, waitingOrders: attached, replay } });
  } catch (error: any) {
    if (error?.issues) {
      return res.status(400).json({ success: false, message: error.issues[0]?.message ?? 'Invalid request' });
    }
    fail(res, error, next);
  }
});

/**
 * What this tenant's Shopify installation looks like, for the Settings screen.
 *
 * `scopes` is included because a merchant who declined one during install will otherwise meet
 * an unexplained failure later, and "Shopify did not grant write_inventory" is something they
 * can actually fix by reconnecting.
 */
router.get('/status', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    const installation = await prisma.shopifyInstallation.findFirst({
      where: { clientId: clientOf(req), uninstalledAt: null },
      select: {
        id: true, shopDomain: true, installedAt: true, claimedAt: true,
        scopes: true, source: true, accessTokenExpiresAt: true
      }
    });

    if (!installation) return res.json({ success: true, data: null });

    res.json({
      success: true,
      data: {
        ...installation,
        // Never the token. Only whether it is currently usable.
        accessTokenExpiresAt: undefined,
        tokenValid: !installation.accessTokenExpiresAt
          || installation.accessTokenExpiresAt.getTime() > Date.now(),
        missingScopes: shopifyInstallationService.missingScopes(installation.scopes)
      }
    });
  } catch (error) {
    next(error);
  }
});

// ── Setting the store up ─────────────────────────────────────────────────────────────────────
//
// Everything below needs a connected store and the same admin permission as connecting one:
// pairing a location decides which shop floor's stock every Shopify sale moves.

/** A store to talk to, for this tenant. */
async function storeApi(req: Request) {
  const installation = await activeInstallation(clientOf(req));
  return adminApiFor(installation.id, installation.shopDomain);
}

/**
 * After anything that could unblock a parked order, try them.
 *
 * Returned with the response so the screen can say "2 waiting orders were placed" at the moment
 * the merchant did the thing that placed them -- the cause and the effect in one sentence.
 */
async function retryWaiting(req: Request) {
  try {
    return await shopifyInboxService.replayAll(clientOf(req), userOf(req));
  } catch (error) {
    console.error('[Shopify] automatic retry after a mapping change failed', error);
    return null;
  }
}

/** The store's locations beside ours, with what is paired to what. */
router.get('/locations', requirePermission(PERMISSION), async (req, res) => {
  try {
    const overview = await shopifyLocationPairingService.overview(clientOf(req), await storeApi(req));
    res.json({ success: true, data: overview });
  } catch (error) {
    respondWithError(res, error, { status: 502, message: 'Could not read your Shopify locations.' });
  }
});

/** Pair one Shopify location with one of ours, or unpair it with `locationId: null`. */
router.put('/locations/:shopifyLocationId', requirePermission(PERMISSION), async (req, res) => {
  try {
    const body = z.object({ locationId: z.string().min(1).nullable() }).parse(req.body);
    const result = await shopifyLocationPairingService.pair(
      clientOf(req), String(req.params.shopifyLocationId), body.locationId, await storeApi(req)
    );
    res.json({ success: true, data: { ...result, replay: body.locationId ? await retryWaiting(req) : null } });
  } catch (error: any) {
    if (error?.issues) {
      return res.status(400).json({ success: false, message: 'Choose a location, or none to unpair.' });
    }
    respondWithError(res, error, { status: 400, message: 'Could not pair that location.' });
  }
});

/** How many products are matched, without asking Shopify. */
router.get('/products/summary', requirePermission(PERMISSION), async (req, res) => {
  try {
    res.json({ success: true, data: await shopifyVariantMatchingService.summary(clientOf(req)) });
  } catch (error) {
    respondWithError(res, error, { status: 400, message: 'Could not read the product matches.' });
  }
});

/**
 * Read the store's products and match them to ours by SKU.
 *
 * A POST although it only reads Shopify, because it writes here -- every match is a row that
 * decides which of our variants a Shopify sale moves.
 */
router.post('/products/match', requirePermission(PERMISSION), async (req, res) => {
  try {
    const result = await shopifyVariantMatchingService.matchBySku(clientOf(req), await storeApi(req));
    res.json({ success: true, data: { ...result, replay: result.newlyMatched > 0 ? await retryWaiting(req) : null } });
  } catch (error) {
    respondWithError(res, error, { status: 502, message: 'Could not match your Shopify products.' });
  }
});

// ── Orders waiting to be placed ──────────────────────────────────────────────────────────────

router.get('/inbox', requirePermission(PERMISSION), async (req, res) => {
  try {
    const state = req.query.state === 'resolved' ? 'resolved' : 'open';
    res.json({ success: true, data: await shopifyInboxService.list(clientOf(req), state) });
  } catch (error) {
    respondWithError(res, error, { status: 500, message: 'Could not load the waiting orders.' });
  }
});

router.get('/inbox/summary', requirePermission(PERMISSION), async (req, res) => {
  try {
    res.json({ success: true, data: await shopifyInboxService.summary(clientOf(req)) });
  } catch (error) {
    respondWithError(res, error, { status: 500, message: 'Could not count the waiting orders.' });
  }
});

router.post('/inbox/replay-all', requirePermission(PERMISSION), async (req, res) => {
  try {
    res.json({ success: true, data: await shopifyInboxService.replayAll(clientOf(req), userOf(req)) });
  } catch (error) {
    respondWithError(res, error, { status: 500, message: 'Could not retry the waiting orders.' });
  }
});

router.post('/inbox/:id/replay', requirePermission(PERMISSION), async (req, res) => {
  try {
    const result = await shopifyInboxService.replay(clientOf(req), String(req.params.id), userOf(req));
    res.json({ success: true, data: result });
  } catch (error) {
    respondWithError(res, error, { status: 500, message: 'Could not retry that order.' });
  }
});

router.post('/inbox/:id/dismiss', requirePermission(PERMISSION), async (req, res) => {
  try {
    const result = await shopifyInboxService.dismiss(
      clientOf(req), String(req.params.id), userOf(req), String(req.body?.reason ?? '')
    );
    res.json({ success: true, data: result });
  } catch (error) {
    respondWithError(res, error, { status: 400, message: 'Could not dismiss that order.' });
  }
});

// ── Privacy requests from Shopify ────────────────────────────────────────────────────────────
//
// A customer asking what the store holds about them, or to be erased, and a store's data being
// erased after it uninstalled. Erasing happens on arrival; a data request waits for the merchant to
// export it and send it on, because Shopify expects the store -- not the app -- to answer the
// customer.

router.get('/privacy-requests', requirePermission(PERMISSION), async (req, res) => {
  try {
    res.json({ success: true, data: await shopifyPrivacyService.list(clientOf(req)) });
  } catch (error) {
    respondWithError(res, error, { status: 500, message: 'Could not load the privacy requests.' });
  }
});

/**
 * Everything held about the customer in one data request.
 *
 * Needs customer:view as well as the Shopify permission: this is a customer's name, phone and
 * addresses, and managing the store connection is not by itself a reason to read those.
 */
router.get('/privacy-requests/:id/export',
  requirePermission(PERMISSION), requirePermission('customer:view'),
  async (req, res) => {
    try {
      const data = await shopifyPrivacyService.export(clientOf(req), String(req.params.id), userOf(req));
      res.json({ success: true, data });
    } catch (error) {
      respondWithError(res, error, { status: 400, message: 'Could not export that request.' });
    }
  });

export default router;
