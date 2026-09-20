import { Router, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { respondWithError } from '../utils/respondWithError';
import { spotService, shelfStockService, shelfIssueService } from '../services/shelves';
import { pickService } from '../services/shelves/pick.service';
import { shelfCountService } from '../services/shelves/count.service';
import {
  bulkSpotsSchema, createSpotSchema, fillShelfSchema, finishFillSchema, moveAllSchema, moveSchema,
  putawaySchema, resolveIssueSchema, updateSpotSchema
} from '../services/shelves/shelf.schema';
import { fillService } from '../services/shelves/fill.service';

/**
 * Racks and shelves.
 *
 *   shelf:view     where is it, what is on a shelf, the put-away list, shelf issues
 *   shelf:putaway  put away, move between shelves, take off a shelf, pick lists, shelf counts,
 *                  reporting pieces not found (sending an order out still needs dispatch:create)
 *   shelf:manage   set up and change the rack tree, labels, resolve shelf issues
 *
 * Every id in a path or body is checked against the signed-in shop inside the service; another
 * shop's id is "not found", never a clue that it exists.
 */
const router = Router();
router.use(tenantMiddleware);

const clientOf = (req: Request) => (req as any).clientId as string;
const userOf = (req: Request) => ((req as any).user?.id as string | undefined) ?? null;
const param = (req: Request, name: string) => String(req.params[name] ?? '');

function parse<T>(schema: ZodSchema<T>, body: unknown, res: Response): T | null {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const field = first?.code === 'unrecognized_keys' ? ` (${(first as any).keys?.join(', ')})` : '';
  res.status(400).json({
    success: false,
    message: first?.code === 'unrecognized_keys' ? `Unexpected field${field}.` : (first?.message ?? 'Check the details and try again.'),
    errors: parsed.error.errors
  });
  return null;
}

const fail = (res: Response, error: unknown, message: string) => respondWithError(res, error, { status: 500, message });

// ── The rack tree ──────────────────────────────────────────────────────────────────────────────
router.get('/locations/:locationId/spots', requirePermission('shelf:view'), async (req, res) => {
  try {
    res.json({ success: true, data: await spotService.tree(clientOf(req), param(req, 'locationId')) });
  } catch (error) { return fail(res, error, 'Could not load the racks and shelves.'); }
});

router.post('/locations/:locationId/spots', requirePermission('shelf:manage'), async (req, res) => {
  const body = parse(createSpotSchema, req.body, res);
  if (!body) return;
  try {
    const spot = await spotService.create(clientOf(req), param(req, 'locationId'), body, userOf(req));
    res.locals.auditAction = 'SHELF_SPOT_CREATED';
    res.locals.auditEntityId = spot.id;
    res.status(201).json({ success: true, data: spot });
  } catch (error) { return fail(res, error, 'Could not add that.'); }
});

router.post('/locations/:locationId/spots/bulk', requirePermission('shelf:manage'), async (req, res) => {
  const body = parse(bulkSpotsSchema, req.body, res);
  if (!body) return;
  try {
    const result = await spotService.bulk(clientOf(req), param(req, 'locationId'), body, userOf(req));
    if (result.saved) res.locals.auditAction = 'SHELF_SPOTS_CREATED';
    res.status(result.saved ? 201 : 200).json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not create those.'); }
});

router.get('/locations/:locationId/labels', requirePermission('shelf:manage'), async (req, res) => {
  try {
    const ids = typeof req.query.spotIds === 'string' ? req.query.spotIds.split(',').filter(Boolean).slice(0, 2000) : undefined;
    res.json({ success: true, data: await spotService.labels(clientOf(req), param(req, 'locationId'), ids) });
  } catch (error) { return fail(res, error, 'Could not prepare the labels.'); }
});

router.get('/locations/:locationId/not-shelved', requirePermission('shelf:view'), async (req, res) => {
  try {
    const page = Number.parseInt(String(req.query.page ?? '1'), 10) || 1;
    res.json({ success: true, data: await shelfStockService.notShelved(clientOf(req), param(req, 'locationId'), Math.min(page, 10_000)) });
  } catch (error) { return fail(res, error, 'Could not load what is waiting to be put away.'); }
});

router.get('/spots/scan', requirePermission('shelf:view'), async (req, res) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code.slice(0, 80) : '';
    const locationId = typeof req.query.locationId === 'string' ? req.query.locationId : undefined;
    const spot = await spotService.resolve(clientOf(req), code, locationId);
    res.json({ success: true, data: await shelfStockService.onSpot(clientOf(req), spot.id) });
  } catch (error) { return fail(res, error, 'Could not read that label.'); }
});

router.get('/spots/:spotId', requirePermission('shelf:view'), async (req, res) => {
  try {
    res.json({ success: true, data: await shelfStockService.onSpot(clientOf(req), param(req, 'spotId')) });
  } catch (error) { return fail(res, error, 'Could not load that shelf.'); }
});

router.get('/spots/:spotId/history', requirePermission('shelf:view'), async (req, res) => {
  try {
    const [movements, addresses] = await Promise.all([
      shelfStockService.history(clientOf(req), param(req, 'spotId')),
      spotService.history(clientOf(req), param(req, 'spotId'))
    ]);
    res.json({ success: true, data: { movements, addresses } });
  } catch (error) { return fail(res, error, 'Could not load that shelf history.'); }
});

router.patch('/spots/:spotId', requirePermission('shelf:manage'), async (req, res) => {
  const body = parse(updateSpotSchema, req.body, res);
  if (!body) return;
  try {
    const spot = await spotService.update(clientOf(req), param(req, 'spotId'), body, userOf(req));
    res.locals.auditAction = 'SHELF_SPOT_UPDATED';
    res.locals.auditEntityId = spot.id;
    res.json({ success: true, data: spot });
  } catch (error) { return fail(res, error, 'Could not save that change.'); }
});

router.delete('/spots/:spotId', requirePermission('shelf:manage'), async (req, res) => {
  try {
    const result = await spotService.remove(clientOf(req), param(req, 'spotId'));
    res.locals.auditAction = 'SHELF_SPOT_REMOVED';
    res.locals.auditEntityId = param(req, 'spotId');
    res.json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not remove that.'); }
});

// ── Where is it ────────────────────────────────────────────────────────────────────────────────
router.get('/find', requirePermission('shelf:view'), async (req, res) => {
  try {
    const locationId = typeof req.query.locationId === 'string' && req.query.locationId ? req.query.locationId : undefined;
    res.json({ success: true, data: await shelfStockService.find(clientOf(req), req.query.q, locationId) });
  } catch (error) { return fail(res, error, 'Could not search.'); }
});

router.get('/variants/:variantId', requirePermission('shelf:view'), async (req, res) => {
  try {
    const locationId = typeof req.query.locationId === 'string' && req.query.locationId ? req.query.locationId : undefined;
    res.json({ success: true, data: await shelfStockService.whereIs(clientOf(req), param(req, 'variantId'), locationId) });
  } catch (error) { return fail(res, error, 'Could not find where that item is.'); }
});

// ── Putting away and moving ────────────────────────────────────────────────────────────────────
router.post('/putaway', requirePermission('shelf:putaway'), async (req, res) => {
  const body = parse(putawaySchema, req.body, res);
  if (!body) return;
  try {
    const result = await shelfStockService.move(clientOf(req), userOf(req), {
      locationId: body.locationId, variantId: body.variantId, toSpotId: body.spotId, quantity: body.quantity
    });
    res.locals.auditAction = 'SHELF_PUT_AWAY';
    res.locals.auditEntityId = body.variantId;
    res.json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not put that away.'); }
});

router.post('/move', requirePermission('shelf:putaway'), async (req, res) => {
  const body = parse(moveSchema, req.body, res);
  if (!body) return;
  try {
    const result = await shelfStockService.move(clientOf(req), userOf(req), body);
    res.locals.auditAction = 'SHELF_MOVE';
    res.locals.auditEntityId = body.variantId;
    res.json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not move that.'); }
});

router.post('/move-all', requirePermission('shelf:putaway'), async (req, res) => {
  const body = parse(moveAllSchema, req.body, res);
  if (!body) return;
  try {
    const result = await shelfStockService.moveAll(clientOf(req), userOf(req), body.fromSpotId, body.toSpotId);
    res.locals.auditAction = 'SHELF_MOVE_ALL';
    res.locals.auditEntityId = body.fromSpotId;
    res.json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not move everything.'); }
});

router.post('/locations/:locationId/spots/import', requirePermission('shelf:manage'), async (req, res) => {
  try {
    const body = req.body ?? {};
    const extra = Object.keys(body).filter(k => k !== 'rows' && k !== 'preview');
    if (extra.length) return res.status(400).json({ success: false, message: `Unexpected field (${extra.join(', ')}).` });
    const result = await spotService.importRows(clientOf(req), param(req, 'locationId'), body.rows, body.preview === true, userOf(req));
    if (result.saved) res.locals.auditAction = 'SHELF_SPOTS_IMPORTED';
    res.status(result.saved ? 201 : 200).json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not import those addresses.'); }
});

// ── Picking, counting, where movements came from ──────────────────────────────────────────────
router.get('/pick/orders', requirePermission('shelf:putaway'), async (req, res) => {
  try {
    res.json({ success: true, data: await pickService.orders(clientOf(req), req.query.locationId) });
  } catch (error) { return fail(res, error, 'Could not load the orders to pick.'); }
});

router.get('/pick/list', requirePermission('shelf:putaway'), async (req, res) => {
  try {
    const ids = typeof req.query.orderIds === 'string' ? req.query.orderIds.split(',').slice(0, 100) : [];
    res.json({ success: true, data: await pickService.list(clientOf(req), req.query.locationId, ids) });
  } catch (error) { return fail(res, error, 'Could not make the pick list.'); }
});

router.post('/not-found', requirePermission('shelf:putaway'), async (req, res) => {
  try {
    const body = req.body ?? {};
    const extra = Object.keys(body).filter(k => !['spotId', 'variantId', 'missing'].includes(k));
    if (extra.length) return res.status(400).json({ success: false, message: `Unexpected field (${extra.join(', ')}).` });
    const result = await pickService.notFound(clientOf(req), userOf(req), body);
    res.locals.auditAction = 'SHELF_NOT_FOUND';
    res.locals.auditEntityId = result.issueId;
    res.status(201).json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not record that.'); }
});

router.post('/spots/:spotId/count', requirePermission('shelf:putaway'), async (req, res) => {
  try {
    const body = req.body ?? {};
    const extra = Object.keys(body).filter(k => k !== 'counts' && k !== 'complete');
    if (extra.length) return res.status(400).json({ success: false, message: `Unexpected field (${extra.join(', ')}).` });
    const result = await shelfCountService.count(clientOf(req), userOf(req), param(req, 'spotId'), body);
    res.locals.auditAction = 'SHELF_COUNTED';
    res.locals.auditEntityId = param(req, 'spotId');
    res.json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not record the count.'); }
});

router.get('/movements', requirePermission('shelf:view'), async (req, res) => {
  try {
    res.json({ success: true, data: await shelfStockService.byReference(clientOf(req), req.query.referenceType, req.query.referenceIds) });
  } catch (error) { return fail(res, error, 'Could not load which shelves were used.'); }
});

// ── Shelf issues ───────────────────────────────────────────────────────────────────────────────
router.get('/issues', requirePermission('shelf:view'), async (req, res) => {
  try {
    res.json({ success: true, data: await shelfIssueService.list(clientOf(req), req.query as any) });
  } catch (error) { return fail(res, error, 'Could not load shelf issues.'); }
});

router.post('/issues/:issueId/resolve', requirePermission('shelf:manage'), async (req, res) => {
  const body = parse(resolveIssueSchema, req.body, res);
  if (!body) return;
  try {
    const issue = await shelfIssueService.resolve(clientOf(req), param(req, 'issueId'), userOf(req), body.note);
    res.locals.auditAction = 'SHELF_ISSUE_RESOLVED';
    res.locals.auditEntityId = issue.id;
    res.json({ success: true, data: issue });
  } catch (error) { return fail(res, error, 'Could not resolve that.'); }
});

// -- The first fill: walking the shelves once and recording what is on them --------------------
router.get('/locations/:locationId/fill', requirePermission('shelf:view'), async (req, res) => {
  try {
    res.json({ success: true, data: await fillService.status(clientOf(req), param(req, 'locationId')) });
  } catch (error) { return fail(res, error, 'Could not load how far the shelves have got.'); }
});

router.post('/spots/:spotId/fill/open', requirePermission('shelf:putaway'), async (req, res) => {
  try {
    const name = ((req as any).user?.name as string | undefined) ?? null;
    res.json({ success: true, data: await fillService.openShelf(clientOf(req), userOf(req), param(req, 'spotId'), name) });
  } catch (error) { return fail(res, error, 'Could not open that shelf.'); }
});

router.post('/spots/:spotId/fill', requirePermission('shelf:putaway'), async (req, res) => {
  const body = parse(fillShelfSchema, req.body, res);
  if (!body) return;
  try {
    const result = await fillService.saveShelf(clientOf(req), userOf(req), param(req, 'spotId'), body);
    res.locals.auditAction = 'SHELF_FILLED';
    res.locals.auditEntityId = param(req, 'spotId');
    res.json({ success: true, data: result });
  } catch (error) { return fail(res, error, 'Could not save that shelf.'); }
});

router.post('/spots/:spotId/fill/skip', requirePermission('shelf:putaway'), async (req, res) => {
  try {
    res.json({ success: true, data: await fillService.skipShelf(clientOf(req), userOf(req), param(req, 'spotId')) });
  } catch (error) { return fail(res, error, 'Could not skip that shelf.'); }
});

router.post('/fill/finish', requirePermission('shelf:manage'), async (req, res) => {
  const body = parse(finishFillSchema, req.body, res);
  if (!body) return;
  try {
    res.json({ success: true, data: await fillService.finish(clientOf(req), userOf(req), body.locationId, !!body.force) });
  } catch (error) { return fail(res, error, 'Could not finish the first fill.'); }
});

router.post('/fill/reopen', requirePermission('shelf:manage'), async (req, res) => {
  const body = parse(finishFillSchema, req.body, res);
  if (!body) return;
  try {
    res.json({ success: true, data: await fillService.reopen(clientOf(req), userOf(req), body.locationId) });
  } catch (error) { return fail(res, error, 'Could not open the first fill again.'); }
});

export default router;
