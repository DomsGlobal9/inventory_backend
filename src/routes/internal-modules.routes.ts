import { Router, Request, Response } from 'express';
import { moduleInventoryGate } from '../services/client-modules/gate';
import { prisma } from '../lib/prisma';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { MODULES, ModuleName, moduleSubscriptions, eventsAfter } from '../services/module-outbox';
import { sessionForToken } from '../controllers/auth.controller';
import { cleanMoved } from '../services/crm-handover';
import internalCrm from './internal-crm.routes';
import internalLogistics from './internal-logistics.routes';
import internalBoutique from './internal-boutique.routes';

/**
 * What other ScaleEzy modules (CRM first) ask Inventory, service to service.
 *
 * Mounted under /api/v1/internal, behind verifyServiceToken: the caller signs a short RS256 token
 * with ITS private key, and Inventory checks it against the public key registered for that service
 * in TRUSTED_SERVICES_KEYS. Inventory holds no secret that could impersonate the module, and the
 * module holds none that could impersonate Inventory. Each route also needs its scope.
 *
 * Not counted in the 100-a-minute-per-address limit (server.ts skips /v1/internal/): every CRM user
 * reaches Inventory from CRM's one address. A per-service limit below takes its place.
 */
const router = Router();

const service = (req: Request) => (req as any).service as { id: string; scopes: string[] };
const needs = (scope: string) => (req: Request, res: Response, next: () => void) =>
  service(req)?.scopes?.includes(scope) ? next() : res.status(403).json({ success: false, message: `This service may not do that (needs ${scope}).` });
const moduleParam = (req: Request, res: Response): ModuleName | null => {
  const m = String(req.params.module);
  if ((MODULES as readonly string[]).includes(m)) return m as ModuleName;
  res.status(404).json({ success: false, message: 'No such module.' });
  return null;
};
// A service may only act for its own module: scope "modules:crm" for CRM. And a key made for ONE shop (it
// carries clientId) may only switch that shop on or off and read that shop's feed, as every route under
// /modules/crm/shops/:clientId already insists (internal-crm.routes `shop`). A key for no shop acts for all.
const ownModule = (req: Request, res: Response, next: () => void) => {
  if (!service(req)?.scopes?.includes(`modules:${req.params.module}`)) return res.status(403).json({ success: false, message: 'This service may not act for that module.' });
  const forShop = (service(req) as any)?.clientId as string | undefined;
  if (forShop && req.params.clientId && forShop !== req.params.clientId) return res.status(403).json({ success: false, message: 'This token is for another shop.' });
  next();
};

router.use(rateLimit({
  windowMs: 60 * 1000,
  // The boutique service carries every CRM-B boutique, so it gets more in all (each boutique also has its own
  // limit, in internal-boutique.routes.ts); every other service keeps the old figure.
  max: (req: Request) => service(req)?.scopes?.includes('modules:boutique')
    ? (Number(process.env.BOUTIQUE_SERVICE_RATE_LIMIT_MAX) > 0 ? Number(process.env.BOUTIQUE_SERVICE_RATE_LIMIT_MAX) : 20000)
    : (Number(process.env.INTERNAL_RATE_LIMIT_MAX) > 0 ? Number(process.env.INTERNAL_RATE_LIMIT_MAX) : 6000),
  keyGenerator: (req) => `service:${service(req)?.id ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests from this service, please try again in a moment.' }
}));

/**
 * Who is this person? The module forwards the token its user signed in with; the answer is the same
 * as GET /auth/session gives the app (user, shop, permissions), checked the same way: active, in that
 * shop, current session number.
 */
router.post('/session', needs('session:read'), async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) return res.status(400).json({ success: false, message: 'Send the user\'s token as "token".' });
  const session = await sessionForToken(token);
  if (!session) return res.status(401).json({ success: false, authenticated: false });
  res.json(session);
});

// A client without Inventory (26 Nov 2026): a module's calls about that shop answer 409 no_inventory (client-modules/gate).
router.use('/modules', moduleInventoryGate);
router.put('/modules/:module/shops/:clientId', ownModule, async (req, res) => {
  const module = moduleParam(req, res); if (!module) return;
  const clientId = String(req.params.clientId);
  /*
   * Found in the joint round with CRM (26 Nov 2026): a module's own delayed job switched its feed back on seconds after
   * the Console switched that module OFF. The Console's switch decides: a module recorded off may not turn its feed
   * on again. (A shop not recorded at all, made before the Console, keeps working as before.)
   */
  const rec = await prisma.clientModule.findUnique({ where: { clientId_module: { clientId, module } }, select: { on: true } });
  if (rec && !rec.on) return res.status(409).json({ success: false, reason: 'module_off', message: `${module} is switched off for this shop in the Platform Console, so its feed stays off.` });
  const sub = await moduleSubscriptions.enable(clientId, module, service(req).id);
  res.json({ success: true, data: { clientId: sub.clientId, module: sub.module, enabledAt: sub.enabledAt } });
});

router.delete('/modules/:module/shops/:clientId', ownModule, async (req, res) => {
  const module = moduleParam(req, res); if (!module) return;
  res.json({ success: true, data: await moduleSubscriptions.disable(String(req.params.clientId), module) });
});

router.get('/modules/:module/shops', ownModule, async (req, res) => {
  const module = moduleParam(req, res); if (!module) return;
  const rows = await moduleSubscriptions.list(module);
  // For CRM, what each shop has handed over to it so far (services/crm-handover).
  res.json({ success: true, data: rows.map(r => ({ clientId: r.clientId, enabledAt: r.enabledAt, ...(module === 'crm' ? { movedToCrm: cleanMoved(r.moved) } : {}) })) });
});

const afterSchema = z.object({ after: z.string().regex(/^\d{1,19}$/).default('0'), limit: z.coerce.number().int().min(1).max(500).default(200) });
router.get('/modules/:module/shops/:clientId/events', ownModule, async (req, res) => {
  const module = moduleParam(req, res); if (!module) return;
  const q = afterSchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ success: false, message: 'after must be a sequence number and limit 1 to 500.' });
  res.json({ success: true, data: await eventsAfter(module, String(req.params.clientId), BigInt(q.data.after), q.data.limit) });
});

// CRM's own questions for one shop: suggestions, locations, customer groups, the hand-over switch.
router.use('/modules/crm', internalCrm);
// Logistics' own questions for one shop: products by SKU (services/logistics).
router.use('/modules/logistics', internalLogistics);
// The boutique (CRM-B): its items and stock on this inventory (PLAN-boutique-sync.md).
router.use('/boutique', internalBoutique);

export default router;
