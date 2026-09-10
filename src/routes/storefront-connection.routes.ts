import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { storefrontConnectionService } from '../services/storefront-connection.service';
import { storefrontEventService } from '../services/storefront-event.service';
import { StorefrontDispatcherService } from '../services/storefront-dispatcher.service';

/**
 * What the merchant uses to connect and manage their storefronts.
 *
 * Behind the normal human session and, like locations, behind an admin permission: connecting
 * a storefront hands an outside system a live read of the whole catalogue and every stock
 * level, which is not a decision for a shop-floor login.
 */

const router = Router();
router.use(tenantMiddleware);

const CONNECTION_PERMISSION = 'admin:locations';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the connection a name').max(80),
  baseUrl: z.string().trim().min(1, 'Enter the address updates should be sent to'),
  type: z.enum(['GENERIC', 'SHOPIFY', 'WOOCOMMERCE']).optional(),
  locationIds: z.array(z.string().uuid()).optional()
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  locationIds: z.array(z.string().uuid()).optional()
});

function clientOf(req: Request): string {
  return (req as any).clientId as string;
}

/** Errors from the service carry a statusCode; anything else is a genuine 500. */
function fail(res: Response, error: any, next: NextFunction) {
  if (error?.statusCode) {
    res.status(error.statusCode).json({ success: false, message: error.message });
    return;
  }
  next(error);
}

router.get('/', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    res.json({ success: true, data: await storefrontConnectionService.list(clientOf(req)) });
  } catch (error) { fail(res, error, next); }
});

/**
 * Creating returns the secret. This is the only time it exists in readable form -- the stored
 * copy is a hash -- so the response says so and the UI must show it before navigating away.
 */
router.post('/', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Invalid request' });
      return;
    }

    const { connection, secret } = await storefrontConnectionService.create(clientOf(req), parsed.data);
    res.status(201).json({
      success: true,
      data: {
        connection: {
          id: connection.id, name: connection.name, status: connection.status,
          baseUrl: connection.baseUrl, credentialPrefix: connection.credentialPrefix,
          locationIds: connection.locationIds
        },
        secret,
        secretIsShownOnce: true
      }
    });
  } catch (error) { fail(res, error, next); }
});

router.get('/:id', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    const connection = await storefrontConnectionService.get(clientOf(req), String(req.params.id));
    if (!connection) {
      res.status(404).json({ success: false, message: 'Connection not found' });
      return;
    }
    res.json({ success: true, data: connection });
  } catch (error) { fail(res, error, next); }
});

router.patch('/:id', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Invalid request' });
      return;
    }
    const updated = await storefrontConnectionService.update(clientOf(req), String(req.params.id), parsed.data);
    res.json({ success: true, data: updated });
  } catch (error) { fail(res, error, next); }
});

router.post('/:id/disable', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    res.json({ success: true, data: await storefrontConnectionService.disable(clientOf(req), String(req.params.id)) });
  } catch (error) { fail(res, error, next); }
});

router.post('/:id/enable', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    res.json({ success: true, data: await storefrontConnectionService.enable(clientOf(req), String(req.params.id)) });
  } catch (error) { fail(res, error, next); }
});

/** Terminal, and irreversible. The UI must confirm before calling this. */
router.post('/:id/revoke', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    res.json({ success: true, data: await storefrontConnectionService.revoke(clientOf(req), String(req.params.id)) });
  } catch (error) { fail(res, error, next); }
});

router.post('/:id/rotate', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    const rotated = await storefrontConnectionService.rotateCredential(clientOf(req), String(req.params.id));
    res.json({ success: true, data: { ...rotated, secretIsShownOnce: true } });
  } catch (error) { fail(res, error, next); }
});

router.get('/:id/deliveries', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const deliveries = await storefrontConnectionService.deliveries(
      clientOf(req), String(req.params.id), Number.isFinite(limit) ? limit : 50
    );
    // sequence is a BigInt, which JSON.stringify refuses to serialise -- the same trap that
    // made the dead-stock report return 500s for exactly the tenants it was meant to help.
    res.json({
      success: true,
      data: deliveries.map(d => ({
        ...d,
        event: d.event ? { ...d.event, sequence: d.event.sequence.toString() } : null
      }))
    });
  } catch (error) { fail(res, error, next); }
});

router.post('/deliveries/:deliveryId/retry', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    await storefrontConnectionService.retryDelivery(clientOf(req), String(req.params.deliveryId));
    // Sent now rather than waiting up to 30s for the next cycle, because a merchant who just
    // pressed Retry is watching the log for it.
    void StorefrontDispatcherService.runOnce();
    res.json({ success: true, data: { queued: true } });
  } catch (error) { fail(res, error, next); }
});

/**
 * Proves the connection before any real stock depends on it.
 *
 * Raises a real event through the real pipeline rather than a special-cased ping, so what it
 * proves is what will actually happen: the URL resolves, the signature verifies at the other
 * end, and the receiver returns 2xx.
 */
router.post('/:id/test', requirePermission(CONNECTION_PERMISSION), async (req, res, next) => {
  try {
    const clientId = clientOf(req);
    const connection = await storefrontConnectionService.get(clientId, String(req.params.id));
    if (!connection) {
      res.status(404).json({ success: false, message: 'Connection not found' });
      return;
    }

    const result = await storefrontEventService.sendTestEvent(clientId, connection.id);
    res.json({ success: true, data: result });
  } catch (error) { fail(res, error, next); }
});

export default router;
