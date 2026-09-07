import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { verifyWebhook } from '../utils/shopifyHmac';
import { normaliseShopDomain } from '../utils/shopifyDomain';
import {
  shopifyInstallationService,
  ShopifyConfigurationError,
  ShopifyInstallError
} from '../services/shopify-installation.service';

/**
 * The two Shopify endpoints that CANNOT be authenticated the normal way.
 *
 * An OAuth callback is a browser redirect and a webhook is a server-to-server POST from
 * Shopify. Neither carries a session cookie, an API key or a tenant header, which is precisely
 * why they are mounted ahead of `authenticate` in api.routes.ts -- and why they must carry
 * their own proof instead.
 *
 * That proof is Shopify's HMAC, and it is the ONLY thing standing between these routes and the
 * open internet. Every handler below verifies it before touching anything.
 */

const router = Router();

/** Where the merchant is sent afterwards. Their own app, not a page served from here. */
function frontendReturn(path: string, params: Record<string, string>) {
  const base = env.FRONTEND_URL.replace(/\/$/, '');
  return `${base}${path}?${new URLSearchParams(params)}`;
}

/**
 * The OAuth callback.
 *
 * Everything that decides whether this is genuine lives in completeInstall; this route's job is
 * to turn the outcome into somewhere sensible for a human to land. A merchant who ends up here
 * is sitting in a browser looking at a blank tab, so every path finishes at a real page.
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { installation, grantedScopes } = await shopifyInstallationService.completeInstall(
      req.query as Record<string, unknown>
    );

    const missing = shopifyInstallationService.missingScopes(grantedScopes);

    // An install that began on Shopify's side has no tenant yet. It is inert until claimed --
    // nothing syncs, nothing is published -- so the merchant is sent to sign in and claim it
    // rather than being told "connected" when nothing is connected to anything.
    if (!installation.clientId) {
      return res.redirect(frontendReturn('/settings', {
        shopify: 'claim',
        shop: installation.shopDomain
      }));
    }

    return res.redirect(frontendReturn('/settings', {
      shopify: 'connected',
      shop: installation.shopDomain,
      ...(missing.length ? { missingScopes: missing.join(',') } : {})
    }));
  } catch (error) {
    const message = error instanceof ShopifyConfigurationError || error instanceof ShopifyInstallError
      ? error.message
      : 'Could not complete the Shopify connection.';

    // Logged in full, shown in summary: the detail of a failed signature check is useful to us
    // and is a probing oracle for anyone testing forged callbacks.
    console.error('[Shopify] install callback failed', error);
    return res.redirect(frontendReturn('/settings', { shopify: 'failed', reason: message }));
  }
});

/**
 * Every inbound webhook, on one route.
 *
 * `req.body` here is a Buffer, not an object -- the route is mounted with a raw body parser
 * ahead of the global `express.json()`. That is not a preference: Shopify's signature covers
 * the exact bytes, and parsing then re-serialising changes key order and whitespace, after
 * which no signature ever matches again. It is the most common way this integration fails.
 *
 * Shopify gives a webhook about five seconds before it counts as failed and is retried, so the
 * work here is: verify, record, acknowledge. Anything slower than that belongs in a queue.
 */
router.post('/webhooks', async (req: Request, res: Response) => {
  const secret = env.SHOPIFY_API_SECRET;
  if (!secret) {
    console.error('[Shopify] webhook received but SHOPIFY_API_SECRET is not configured');
    return res.status(503).json({ success: false, message: 'Shopify is not configured here.' });
  }

  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));

  if (!verifyWebhook(raw, req.headers['x-shopify-hmac-sha256'], secret)) {
    // 401 with no detail. A forged webhook must not learn anything about why it was rejected.
    return res.status(401).json({ success: false });
  }

  const topic = String(req.headers['x-shopify-topic'] ?? '');
  const webhookId = String(req.headers['x-shopify-webhook-id'] ?? '');
  const shopDomain = normaliseShopDomain(req.headers['x-shopify-shop-domain']);

  if (!topic || !webhookId || !shopDomain) {
    return res.status(400).json({ success: false });
  }

  // Recorded BEFORE it is acted on, and the unique key does the deduplication. Shopify
  // redelivers the same webhook by design -- on a timeout, on a 5xx, sometimes simply twice --
  // so "have we seen this one" has to be a database constraint rather than an intention.
  try {
    await prisma.shopifyWebhookReceipt.create({ data: { webhookId, topic, shopDomain } });
  } catch {
    // Already recorded. Acknowledge so Shopify stops retrying, and do nothing else: the first
    // delivery either handled it or recorded why it could not.
    return res.status(200).json({ success: true, duplicate: true });
  }

  // Acknowledged first, handled after. A slow handler would otherwise be retried by Shopify
  // while the first attempt is still running, which turns one order into two.
  res.status(200).json({ success: true });

  try {
    const outcome = await handleWebhook(topic, shopDomain, raw);
    await prisma.shopifyWebhookReceipt.updateMany({
      where: { webhookId, topic }, data: { processedAt: new Date(), outcome }
    });
  } catch (error: any) {
    console.error(`[Shopify] webhook ${topic} for ${shopDomain} failed`, error);
    await prisma.shopifyWebhookReceipt.updateMany({
      where: { webhookId, topic },
      data: { processedAt: new Date(), outcome: 'FAILED', error: String(error?.message ?? error).slice(0, 500) }
    }).catch(() => undefined);
  }
});

/**
 * What each topic means to us.
 *
 * Topics we do not act on yet are acknowledged and recorded rather than rejected. Shopify
 * treats a non-2xx as a failure and retries for days, then removes the subscription -- so
 * refusing an unhandled topic is worse than accepting and ignoring it.
 */
async function handleWebhook(topic: string, shopDomain: string, raw: Buffer): Promise<string> {
  switch (topic) {
    case 'app/uninstalled': {
      // The token is already dead at this point; Shopify revoked it when the merchant clicked
      // uninstall. Without this the dispatcher keeps trying it forever -- the exact "dead
      // connection retrying into the void" the generic pipeline was designed to avoid.
      const installation = await shopifyInstallationService.markUninstalled(shopDomain);
      if (installation) {
        const connections = await prisma.storefrontConnection.findMany({
          where: { clientId: installation.clientId ?? '__none__', type: 'SHOPIFY' },
          select: { id: true }
        });
        for (const connection of connections) {
          await prisma.storefrontConnection.update({
            where: { id: connection.id }, data: { status: 'REVOKED' }
          });
          // Queued work for a store that no longer has the app is not "pending", it is over.
          await prisma.storefrontDelivery.updateMany({
            where: { connectionId: connection.id, status: { in: ['PENDING', 'RETRYING'] } },
            data: {
              status: 'CANCELLED',
              lastError: 'The app was uninstalled from this Shopify store.',
              nextAttemptAt: null,
              lockedAt: null
            }
          });
        }
      }
      return 'APPLIED';
    }

    // The three privacy topics Shopify requires of a distributed app. They must be subscribed
    // and must answer 2xx before review; the substantive work has 30 days, which is why these
    // record intent rather than deleting inline.
    case 'customers/data_request':
    case 'customers/redact':
      // ScaleEzy stores no Shopify customer records: the integration reads products, inventory
      // and locations. There is nothing to return or erase, and saying so is the correct
      // response rather than a silent 200.
      return 'IGNORED';

    case 'shop/redact': {
      // Sent 48 hours after uninstall. Everything tying us to that shop goes: the installation
      // row cascades its id maps, location maps and echo records.
      const shop = normaliseShopDomain(shopDomain);
      if (shop) {
        await prisma.shopifyInstallation.deleteMany({ where: { shopDomain: shop } });
      }
      return 'APPLIED';
    }

    default:
      void raw;
      return 'IGNORED';
  }
}

export default router;
