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
    const body = z.object({ shop: z.string().min(1, 'Enter your Shopify store address') }).parse(req.body);
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
    const body = z.object({ shop: z.string().min(1) }).parse(req.body);
    const installation = await shopifyInstallationService.claim(body.shop, clientOf(req), userOf(req));
    res.json({ success: true, data: installation });
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

export default router;
