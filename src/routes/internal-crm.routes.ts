import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { loadIdentity } from '../lib/identityCache';
import { grants, holdsEverything } from '../config/permissions';
import { customerCard } from '../services/customer-card';
import { customerGroups } from '../services/customer-groups';
import { crmHandover } from '../services/crm-handover';
import { isAuditNoise } from '../services/audit-feed.service';
import { pruneAuditLogs } from '../services/security-log';
import { respondWithError } from '../utils/respondWithError';

/**
 * What ScaleEzy CRM asks Inventory for one shop, mounted at /api/v1/internal/modules/crm (behind
 * verifyServiceToken and the per-service limit in internal-modules.routes). Every route needs the
 * modules:crm scope, and the shop must have CRM switched on.
 *
 * Inventory's own logic stays the one source: the suggestions are the Customer card's rules
 * (services/customer-card) and the groups are Settings → Customer groups (services/customer-groups),
 * called exactly as the app's routes call them -- same checks, same 409 while a live offer uses a group.
 *
 * Changes are made FOR a person: the service token carries clientId and onBehalfOf { userId }. That
 * person must be ACTIVE in this shop and hold the same permission the app asks for; the activity log
 * then names them, as if they had done it in Inventory.
 */
const router = Router();

type Service = { id: string; scopes: string[]; clientId?: string; onBehalfOf?: { userId: string } };
const service = (req: Request) => (req as any).service as Service;
const clientIdOf = (req: Request) => String(req.params.clientId);
const fail = (res: Response, status: number, message: string) => res.status(status).json({ success: false, message });

router.use((req, res, next) => service(req)?.scopes?.includes('modules:crm') ? next() : fail(res, 403, 'This service may not do that (needs modules:crm).'));

/** The shop named in the address: switched on for CRM, and the token's own shop when it names one. */
const shop = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = service(req);
    if (s.clientId && s.clientId !== clientIdOf(req)) return fail(res, 403, 'This token is for another shop.');
    const sub = await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: clientIdOf(req), module: 'crm' } }, select: { clientId: true } });
    if (!sub) return fail(res, 404, 'This shop has not switched CRM on.');
    next();
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
};

/**
 * Who the change is for: onBehalfOf.userId, a person ACTIVE in this very shop with `permission`
 * (null = the owner only). Refused otherwise -- a change nobody can be named for is not made.
 */
const person = (permission: string | null) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = service(req);
    const userId = s.onBehalfOf?.userId;
    if (!userId || s.clientId !== clientIdOf(req)) return fail(res, 403, 'Say who this is for: the token needs clientId and onBehalfOf { userId } for this shop.');
    const u = await loadIdentity(userId);
    if (!u || u.clientId !== clientIdOf(req)) return fail(res, 403, 'That person is not in this shop.');
    if (u.status !== 'ACTIVE') return fail(res, 403, 'That person\'s account is switched off.');
    const owner = holdsEverything(u.permissions, u.roles);
    if (permission === null ? !owner : !(owner || grants(u.permissions, permission))) {
      return fail(res, 403, permission === null ? 'Only the shop\'s owner can change this.' : `That person may not do this in Inventory (needs ${permission}).`);
    }
    (req as any).actor = { id: u.id, name: u.name };
    next();
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
};

/** The same row the app's activity logger writes for the matching Inventory route, naming the person. */
function logActivity(req: Request, action: string, entityType: string, entityId: string) {
  const clientId = clientIdOf(req);
  const userId = (req as any).actor?.id as string | undefined;
  if (!userId || isAuditNoise(entityType, action)) return;
  prisma.auditLog.create({ data: { clientId, userId, action, entityType, entityId: entityId || 'n/a', ipAddress: req.ip } })
    .then(() => pruneAuditLogs(clientId))
    .catch(err => console.error('internal-crm: failed to record activity', err));
}

const act = (fn: (req: Request) => Promise<unknown>, audit?: (req: Request) => [action: string, entityId: string]) =>
  async (req: Request, res: Response) => {
    try {
      const data = await fn(req);
      if (audit) { const [action, id] = audit(req); logActivity(req, action, 'CUSTOMER_GROUP', id); }
      res.json({ success: true, data });
    } catch (error) { return respondWithError(res, error, { status: 400 }); }
  };
const key = (req: Request) => String(req.params.key ?? '').trim().toLowerCase();

// ---- Locations and the Customer card's suggestions ------------------------------------------------

router.get('/shops/:clientId/locations', shop, async (req, res) => {
  try {
    const rows = await prisma.stockLocation.findMany({ where: { clientId: clientIdOf(req), active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    res.json({ success: true, data: rows });
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
});

router.get('/shops/:clientId/customers/:customerId/suggestions', shop, async (req, res) => {
  try {
    const clientId = clientIdOf(req);
    const locationId = typeof req.query.locationId === 'string' && req.query.locationId ? req.query.locationId : undefined;
    if (locationId && !(await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true } }))) {
      return fail(res, 404, 'That store is not this shop\'s.');
    }
    const data = await customerCard.suggestionsFor(clientId, String(req.params.customerId), locationId);
    if (!data) return fail(res, 404, 'That customer is not this shop\'s.');
    res.json({ success: true, data });
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
});

// ---- Customer groups: the same service functions as routes/customer-groups.routes.ts --------------

const cid = clientIdOf;
const readable = async (req: Request, res: Response, next: NextFunction) =>
  // Reading needs no person; when one is named, they must still be able to see customers.
  service(req).onBehalfOf ? person('customer:view')(req, res, next) : next();

router.get('/shops/:clientId/groups', shop, readable, act(req => customerGroups.list(cid(req))));
router.post('/shops/:clientId/groups', shop, person('customer:manage_groups'), act(req => customerGroups.create(cid(req), req.body?.name), req => ['CREATED', 'n/a']));
router.post('/shops/:clientId/groups/members', shop, person('customer:update'), act(req => customerGroups.addMembers(cid(req), req.body?.group, req.body?.customerIds), () => ['MEMBERS', 'members']));
router.get('/shops/:clientId/groups/:key/members', shop, readable, act(req => customerGroups.members(cid(req), key(req))));
router.delete('/shops/:clientId/groups/:key/members/:customerId', shop, person('customer:update'), act(req => customerGroups.removeMember(cid(req), key(req), String(req.params.customerId)), req => ['MEMBERS', key(req)]));
router.post('/shops/:clientId/groups/:key/rename', shop, person('customer:manage_groups'), act(req => customerGroups.rename(cid(req), key(req), req.body?.name), req => ['RENAME', key(req)]));
router.post('/shops/:clientId/groups/:key/merge', shop, person('customer:manage_groups'), act(req => customerGroups.rename(cid(req), key(req), req.body?.into, { merge: true }), req => ['MERGE', key(req)]));
router.patch('/shops/:clientId/groups/:key/rules', shop, person('customer:manage_groups'), act(req => customerGroups.setRules(cid(req), key(req), req.body), req => ['RULES', key(req)]));
router.delete('/shops/:clientId/groups/:key', shop, person('customer:manage_groups'), act(req => customerGroups.remove(cid(req), key(req)), req => ['DELETED', key(req)]));

// ---- The hand-over switch ---------------------------------------------------------------------------

router.get('/shops/:clientId/moved', shop, async (req, res) => {
  try { res.json({ success: true, data: await crmHandover.get(clientIdOf(req)) }); }
  catch (error) { return respondWithError(res, error, { status: 500 }); }
});

// The owner decides what moves; campaigns and wishes keep their safety rules (services/crm-handover).
router.put('/shops/:clientId/moved', shop, person(null), async (req, res) => {
  try {
    const moved = await crmHandover.set(clientIdOf(req), req.body);
    logActivity(req, 'UPDATED', 'CRM_HANDOVER', clientIdOf(req));
    res.json({ success: true, data: moved });
  } catch (error) { return respondWithError(res, error, { status: 400 }); }
});

export default router;
