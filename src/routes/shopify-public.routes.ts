import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { verifyWebhook, verifyOAuthCallback } from '../utils/shopifyHmac';
import { normaliseShopDomain } from '../utils/shopifyDomain';
import {
  shopifyInstallationService,
  ShopifyConfigurationError,
  ShopifyInstallError
} from '../services/shopify-installation.service';
import {
  shopifyOrderIngestService,
  shopifyOrderCancelService,
  shopifyFulfilmentService,
  shopifyRefundService,
  shopifyInboxService
} from '../services/shopify-orders';
import { offerMirrorService, discountGidFromWebhook } from '../services/shopify-discounts';
import { shopifyPrivacyService } from '../services/shopify-privacy';

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
 * The App URL: where Shopify sends a merchant who installs from Shopify's side.
 *
 * This is a GET carrying `shop`, `timestamp` and `hmac`, and Shopify expects a 3xx to the
 * grant screen. It is NOT the same as the authenticated POST a merchant uses from inside
 * ScaleEzy, and both have to exist:
 *
 *   POST /shopify-connect/install   a signed-in merchant -- the tenant is known before OAuth
 *   GET  /shopify/install           Shopify itself       -- no tenant is knowable at all
 *
 * Without this route the App URL has nothing to answer it, and installing from a listing or a
 * shared link silently does nothing. There is no error to see; the merchant simply never
 * arrives at the grant screen.
 *
 * The install still completes: the token is stored, and the installation lands UNCLAIMED --
 * inert, syncing nothing -- until someone signs in and says it is theirs.
 */
router.get('/install', async (req: Request, res: Response) => {
  const secret = env.SHOPIFY_API_SECRET;
  if (!secret) {
    return res.status(503).json({ success: false, message: 'Shopify is not configured here.' });
  }

  // Shopify signs this request too, with the same query-string scheme as the callback. Checked
  // before anything else, because the next thing we do is build a URL out of `shop` -- and an
  // unverified `shop` is a request to send a merchant somewhere we did not choose.
  if (!verifyOAuthCallback(req.query as Record<string, unknown>, secret)) {
    return res.status(401).json({ success: false, message: 'This request did not come from Shopify.' });
  }

  try {
    const { authorizeUrl } = await shopifyInstallationService.beginInstall({
      shop: String(req.query.shop ?? '')
      // No clientId: nothing here can know which ScaleEzy workspace this shop belongs to, and
      // guessing would bind a stranger's store to a tenant. It is claimed later, by a human.
    });
    return res.redirect(authorizeUrl);
  } catch (error) {
    const message = error instanceof ShopifyConfigurationError || error instanceof ShopifyInstallError
      ? error.message
      : 'Could not start the Shopify installation.';
    console.error('[Shopify] install entry failed', error);
    return res.redirect(frontendReturn('/settings', { shopify: 'failed', reason: message }));
  }
});

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
    const outcome = await handleWebhook(topic, shopDomain, webhookId, raw);
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
async function handleWebhook(topic: string, shopDomain: string, webhookId: string, raw: Buffer): Promise<string> {
  switch (topic) {
    /*
     * The sales themselves.
     *
     * Parsed here rather than in the route because the signature is verified over the exact
     * bytes, and `raw` is what was signed -- see the note on the route above. Everything below
     * returns an outcome instead of throwing: Shopify retries a non-2xx for days and then
     * unsubscribes the topic, which is a far worse failure than an order parked where somebody
     * can see it.
     */
    case 'orders/create':
    case 'orders/updated': {
      const payload = JSON.parse(raw.toString('utf8'));
      const result = await shopifyOrderIngestService.ingest(shopDomain, payload, topic);

      /*
       * Placed -- so anything that happened to it while it waited happens now.
       *
       * An order can be placed by a fresh webhook as easily as by somebody pressing Retry, and a
       * shipment parked behind it must not depend on which. Failure here is logged and left
       * parked; the order itself is already safely placed and Shopify must still get its 200.
       */
      if (result.status === 'APPLIED') {
        const installation = await prisma.shopifyInstallation.findUnique({
          where: { shopDomain }, select: { clientId: true }
        });
        if (installation?.clientId) {
          await shopifyInboxService
            .applyFollowUps(installation.clientId, shopDomain, String(payload.id), result.salesOrderId)
            .catch(error => console.error(`[Shopify] follow-ups for ${payload.id} failed`, error));
        }
      }
      return result.status;
    }

    case 'orders/cancelled': {
      const payload = JSON.parse(raw.toString('utf8'));
      return shopifyOrderCancelService.cancel(shopDomain, payload);
    }

    /*
     * Goods leaving, and money going back.
     *
     * Both read ABSOLUTE state rather than a delta -- how much Shopify says has shipped in total,
     * and which refund id this is -- so a redelivery moves nothing a second time. That is what
     * makes Shopify's habit of sending the same webhook twice harmless rather than expensive.
     */
    case 'orders/fulfilled': {
      const payload = JSON.parse(raw.toString('utf8'));
      return shopifyFulfilmentService.apply(shopDomain, payload);
    }

    case 'refunds/create': {
      const payload = JSON.parse(raw.toString('utf8'));
      return shopifyRefundService.apply(shopDomain, payload);
    }

    /*
     * A discount changed or was deleted in Shopify.
     *
     * Only a hint: the copy is flagged to be read back on the worker's next pass, and the read-back
     * decides whether it drifted. The scheduled read-back every 30 minutes is the guaranteed path
     * and does not depend on these topics being subscribed at all -- they need read_discounts, and a
     * store that has not re-approved simply never sends them.
     */
    case 'discounts/update':
    case 'discounts/delete': {
      const payload = JSON.parse(raw.toString('utf8'));
      const discountGid = discountGidFromWebhook(payload);
      if (!discountGid) return 'IGNORED';
      const flagged = await offerMirrorService.flagChangedInShopify(discountGid);
      return flagged > 0 ? 'APPLIED' : 'IGNORED';
    }

    case 'app/uninstalled': {
      // The token is already dead at this point; Shopify revoked it when the merchant clicked
      // uninstall. Without this the dispatcher keeps trying it forever -- the exact "dead
      // connection retrying into the void" the generic pipeline was designed to avoid.
      const installation = await shopifyInstallationService.markUninstalled(shopDomain);
      // Nothing parked for this store can ever be placed now. Closed, not deleted, so a merchant
      // who reinstalls can still see what was waiting when they left.
      await shopifyInboxService.closeForUninstall(shopDomain);
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

    /*
     * The three privacy topics Shopify requires of a distributed app.
     *
     * These used to be ignored on the grounds that no Shopify customer data was stored. Order
     * ingestion made that untrue: a Shopify order creates a customer, copies their name, phone and
     * addresses onto the sales order, and keeps the webhook body for replay. Each request is
     * recorded, then worked -- see services/shopify-privacy for what each one does and does not
     * touch. Already acknowledged by this point, so a failure is left on the request row for
     * housekeeping to retry rather than thrown back at Shopify.
     */
    case 'customers/data_request':
    case 'customers/redact':
    case 'shop/redact': {
      const payload = JSON.parse(raw.toString('utf8'));
      return shopifyPrivacyService.receive(topic, shopDomain, webhookId, payload);
    }

    default:
      void raw;
      return 'IGNORED';
  }
}

export default router;
