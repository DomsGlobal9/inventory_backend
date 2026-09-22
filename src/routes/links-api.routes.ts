import { Router, Request, Response, NextFunction } from 'express';
import { verifyServiceToken, ServiceIdentity } from '../middleware/service.middleware';
import { links, LinkRuleError } from '../services/links';

/**
 * Short links for other ScaleEzy services (Billing, Marketing, the online shop...).
 *
 * The caller proves itself with a signed service token (verifyServiceToken): the token names the
 * service and the shop, so nothing here trusts a shop id from the body. A service only ever sees
 * and changes its own links: the owner module is taken from the token, never from the request, and
 * is prefixed so no service can pass for Inventory's own ("campaigns").
 *
 *   links:write   make links, switch them off and on
 *   links:read    counts
 */
const router = Router();
router.use(verifyServiceToken);

const moduleOf = (s: ServiceIdentity) => `svc-${String(s.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'unknown'}`;

const withScope = (scope: 'links:write' | 'links:read', fn: (req: Request, svc: ServiceIdentity & { clientId: string }) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const svc = (req as any).service as ServiceIdentity;
    if (!svc.scopes.includes(scope)) return res.status(403).json({ success: false, message: `This service token lacks the ${scope} scope.` });
    if (!svc.clientId) return res.status(403).json({ success: false, message: 'Short links belong to a shop: the service token must name one (clientId).' });
    try {
      res.status(status).json({ success: true, data: await fn(req, svc as ServiceIdentity & { clientId: string }) });
    } catch (e) {
      if (e instanceof LinkRuleError) return res.status(400).json({ success: false, message: e.message });
      next(e);
    }
  };

const refOf = (v: unknown) => (typeof v === 'string' && v ? v : null);

router.post('/links', withScope('links:write', (req, svc) => links.makeLinks({
  clientId: svc.clientId,
  owner: { module: moduleOf(svc), ref: refOf(req.body?.ref) },
  links: Array.isArray(req.body?.links) ? req.body.links : [],
  days: req.body?.days ?? null,
  isTest: req.body?.isTest === true
}).then(made => ({ links: made })), 201));

router.get('/stats', withScope('links:read', (req, svc) =>
  links.statsFor(svc.clientId, { module: moduleOf(svc), ref: refOf(req.query.ref) })));

router.post('/taps', withScope('links:read', async (req, svc) => {
  const refs = Array.isArray(req.body?.recipientRefs) ? req.body.recipientRefs.filter((r: unknown) => typeof r === 'string') : [];
  const byRef = await links.tapsByRecipient(svc.clientId, { module: moduleOf(svc), ref: refOf(req.body?.ref) }, refs);
  return { recipients: Object.fromEntries(byRef) };
}));

router.post('/disable', withScope('links:write', (req, svc) =>
  links.disableForOwner(svc.clientId, { module: moduleOf(svc), ref: refOf(req.body?.ref) }, null)));

router.post('/enable', withScope('links:write', (req, svc) =>
  links.enableForOwner(svc.clientId, { module: moduleOf(svc), ref: refOf(req.body?.ref) })));

export default router;
