import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { loadIdentity } from '../lib/identityCache';
import { grants, holdsEverything } from '../config/permissions';
import { customerCard } from '../services/customer-card';
import { customerGroups } from '../services/customer-groups';
import * as shopReviews from '../services/shop-reviews';
import { crmHandover } from '../services/crm-handover';
import { offersState, setOffersConsent } from '../services/campaigns';
import { customerService } from '../services/customer.service';
import * as customerDelete from '../services/customer-delete';
import { pastPurchases } from '../services/past-purchases';
import { isAuditNoise } from '../services/audit-feed.service';
import { pruneAuditLogs } from '../services/security-log';
import { respondWithError } from '../utils/respondWithError';
import { badRequest } from '../utils/httpError';

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
    (req as any).actor = { id: u.id, name: u.name, clientId: u.clientId, permissions: u.permissions, roles: u.roles };
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

const act = (fn: (req: Request) => Promise<unknown>, audit?: (req: Request, data: any) => [action: string, entityId: string], entityType = 'CUSTOMER_GROUP') =>
  async (req: Request, res: Response) => {
    try {
      const data = await fn(req);
      if (audit) { const [action, id] = audit(req, data); logActivity(req, action, entityType, id); }
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

// ---- A customer's offers answer, birthday and anniversary, and deleting them (moved.profile) --------
// The same service functions as the app (campaign.routes consent, customer.routes PATCH and DELETE), with
// the same checks and words. They work whether or not the shop has moved these to CRM, so CRM can build
// and test its screens first and then turn moved.profile on.

const customerIdOf = (req: Request) => String(req.params.customerId);
const actorOf = (req: Request) => (req as any).actor as { id: string; clientId: string; permissions?: string[]; roles?: string[] };

// ---- Reviews and private feedback (services/shop-reviews): managed here, shown on the shop ----------
// Reply and hide. Never the customer's own words: a shop that could rewrite a review could write its own.
const actorName = (req: Request) => String((req as any).actor?.name ?? 'Store');
router.get('/shops/:clientId/reviews/stats', shop, readable, act(req => shopReviews.crm.stats(clientIdOf(req))));
router.get('/shops/:clientId/reviews/hide-reasons', shop, readable, act(async () => shopReviews.crm.hideReasons()));
router.get('/shops/:clientId/reviews', shop, readable, act(req => shopReviews.crm.list(clientIdOf(req), req.query)));
router.post('/shops/:clientId/reviews/:id/reply', shop, person('customer:update'),
  act(req => shopReviews.crm.reply(clientIdOf(req), req.params.id, req.body?.text, actorName(req)), req => ['REPLY_REVIEW', String(req.params.id)], 'ShopReview'));
router.delete('/shops/:clientId/reviews/:id/reply', shop, person('customer:update'),
  act(req => shopReviews.crm.removeReply(clientIdOf(req), req.params.id), req => ['REMOVE_REVIEW_REPLY', String(req.params.id)], 'ShopReview'));
router.post('/shops/:clientId/reviews/:id/hide', shop, person('customer:update'),
  act(req => shopReviews.crm.hide(clientIdOf(req), req.params.id, req.body?.reason, actorName(req)), req => ['HIDE_REVIEW', String(req.params.id)], 'ShopReview'));
router.post('/shops/:clientId/reviews/:id/unhide', shop, person('customer:update'),
  act(req => shopReviews.crm.unhide(clientIdOf(req), req.params.id), req => ['UNHIDE_REVIEW', String(req.params.id)], 'ShopReview'));
router.get('/shops/:clientId/orders/:salesOrderId/review-link', shop, readable, act(req => shopReviews.crm.reviewLink(clientIdOf(req), req.params.salesOrderId)));
router.get('/shops/:clientId/feedback', shop, readable, act(req => shopReviews.crm.feedback(clientIdOf(req), req.query)));
router.post('/shops/:clientId/feedback/:id/handled', shop, person('customer:update'),
  act(req => shopReviews.crm.setFeedbackHandled(clientIdOf(req), req.params.id, req.body?.handled !== false, actorName(req)), req => ['HANDLE_FEEDBACK', String(req.params.id)], 'ShopOrderFeedback'));

// ---- Bills from before ScaleEzy (services/past-purchases). Inventory holds them; billedOn null = date not known. ----
// One customer's bills and buying pattern, worked out by the same rules the Inventory page uses.
router.get('/shops/:clientId/customers/:customerId/past-purchases', shop, readable, act(req => pastPurchases.forCustomer(cid(req), customerIdOf(req))));
// Every past bill, to catch up: pass the last `next` as ?after=. New ones and deletes also come on the feed.
router.get('/shops/:clientId/past-purchases', shop, readable, act(req => pastPurchases.page(cid(req), req.query)));

router.get('/shops/:clientId/customers/:customerId/offers', shop, readable,
  act(req => offersState(cid(req), customerIdOf(req))));
router.put('/shops/:clientId/customers/:customerId/offers', shop, person('customer:update'),
  act(req => setOffersConsent(actorOf(req), customerIdOf(req), req.body?.agreed), req => ['UPDATED', customerIdOf(req)], 'CUSTOMER'));
// { birthday?, anniversary? }: "MM-DD" (a year is dropped), or null to clear. Only what is sent changes.
router.put('/shops/:clientId/customers/:customerId/dates', shop, person('customer:update'), act(async req => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const change: { birthday?: unknown; anniversary?: unknown } = {};
  if ('birthday' in body) change.birthday = body.birthday;
  if ('anniversary' in body) change.anniversary = body.anniversary;
  if (!Object.keys(change).length) throw badRequest('Send a birthday or an anniversary to change: month and day, like 08-14, or empty to clear it.');
  const c = await customerService.updateCustomer(cid(req), customerIdOf(req), change);
  return { birthday: c.birthday, anniversary: c.anniversary };
}, req => ['UPDATED', customerIdOf(req)], 'CUSTOMER'));
// The owner only, as in the app; confirm = the last 4 digits of their number, or their name without one.
router.get('/shops/:clientId/customers/:customerId/delete-preview', shop, person(null),
  act(req => customerDelete.preview(cid(req), customerIdOf(req))));
router.delete('/shops/:clientId/customers/:customerId', shop, person(null),
  act(req => customerDelete.deleteCustomer(cid(req), customerIdOf(req), req.body?.confirm),
    (req, data) => [data?.mode === 'REMOVE' ? 'CUSTOMER_DELETED' : 'CUSTOMER_ERASED', customerIdOf(req)], 'CUSTOMER'));

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
