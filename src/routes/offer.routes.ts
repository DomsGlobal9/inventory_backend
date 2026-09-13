import { Router, Request, Response } from 'express';
import { offerService, offerInsightService } from '../services/offers';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { grants, holdsEverything } from '../config/permissions';
import { respondWithError } from '../utils/respondWithError';
import { offerMirrorService } from '../services/shopify-discounts';
import { adminApiFor } from '../services/shopify-mapping';

/**
 * Offers: the rules a shop writes once and sells by everywhere.
 *
 * Read is separated from write, and writing is separated from PUSHING to a live Shopify store --
 * the last of those changes somebody's public shop front, and a shop may well want a manager
 * writing offers without being able to touch it.
 *
 * Nothing here prices a basket. The engine that does is Phase 3.
 */
const router = Router();
router.use(tenantMiddleware);

const clientOf = (req: Request) => (req as any).clientId as string;
const userOf = (req: Request) => (req as any).user?.id as string | undefined;

router.get('/', requirePermission('offer:view'), async (req: Request, res: Response) => {
  try {
    const offers = await offerService.list(clientOf(req), {
      status: req.query.status ? String(req.query.status) : undefined,
      search: req.query.search ? String(req.query.search) : undefined
    });
    // Each offer's Shopify copy, if it has one, so the list can say "on Shopify" or "changed there"
    // without a request per row.
    const mirrors = await offerMirrorService.summaries(clientOf(req), offers.map((o: any) => o.id));
    res.json({ success: true, data: offers.map((o: any) => ({ ...o, shopify: mirrors.get(o.id) ?? null })) });
  } catch (error) {
    return respondWithError(res, error, { status: 500, message: 'Could not load the offers.' });
  }
});

// Declared before /:id, or Express would read "settings" or "options" as an offer id.
router.get('/settings', requirePermission('offer:view'), async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await offerService.getSettings(clientOf(req)) });
  } catch (error) {
    return respondWithError(res, error, { status: 500, message: 'Could not load the till rules.' });
  }
});

router.put('/settings', requirePermission('offer:settings'), async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await offerService.setSettings(clientOf(req), req.body ?? {}) });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not save the till rules.' });
  }
});

router.get('/options', requirePermission('offer:view'), async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await offerInsightService.options(clientOf(req)) });
  } catch (error) {
    return respondWithError(res, error, { status: 500, message: 'Could not load what offers can apply to.' });
  }
});

router.get('/targets', requirePermission('offer:view'), async (req: Request, res: Response) => {
  try {
    const scope = String(req.query.scope ?? '').toUpperCase();
    const data = await offerInsightService.search(clientOf(req), scope, String(req.query.q ?? ''));
    res.json({ success: true, data });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not search.' });
  }
});

router.get('/:id', requirePermission('offer:view'), async (req: Request, res: Response) => {
  try {
    // Together, not one after the other: the Shopify summary needs only the id from the URL.
    const id = String(req.params.id);
    const [detail, mirrors] = await Promise.all([
      offerInsightService.detail(clientOf(req), id),
      offerMirrorService.summaries(clientOf(req), [id])
    ]);
    res.json({ success: true, data: { ...detail, shopify: mirrors.get(id) ?? null } });
  } catch (error) {
    return respondWithError(res, error, { status: 500, message: 'Could not load that offer.' });
  }
});

router.post('/', requirePermission('offer:create'), async (req: Request, res: Response) => {
  try {
    const offer = await offerService.create(clientOf(req), req.body, userOf(req));
    res.status(201).json({ success: true, data: offer });
  } catch (error) {
    // 400 as the fallback, not 500: almost everything that goes wrong here is something the
    // merchant typed, and validateOffer has already said so in words they can act on.
    return respondWithError(res, error, { status: 400, message: 'Could not save that offer.' });
  }
});

router.patch('/:id', requirePermission('offer:update'), async (req: Request, res: Response) => {
  try {
    const { changeNote, ...input } = req.body ?? {};
    const offer = await offerService.update(clientOf(req), String(req.params.id), input, userOf(req), changeNote);
    res.json({ success: true, data: offer });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not save that offer.' });
  }
});

/** A copy to start from -- always a draft, never carrying the original's codes or uses. */
router.post('/:id/duplicate', requirePermission('offer:create'), async (req: Request, res: Response) => {
  try {
    const copy = await offerService.duplicate(clientOf(req), String(req.params.id), userOf(req));
    res.status(201).json({ success: true, data: copy });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not copy that offer.' });
  }
});

// ── Single-use codes ────────────────────────────────────────────────────────────────────────────

router.get('/:id/codes', requirePermission('offer:view'), async (req: Request, res: Response) => {
  try {
    const data = await offerService.listCodes(clientOf(req), String(req.params.id), {
      status: req.query.status ? String(req.query.status).toUpperCase() : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      take: req.query.take ? Number(req.query.take) : undefined,
      skip: req.query.skip ? Number(req.query.skip) : undefined,
      all: req.query.all === '1' || req.query.all === 'true'
    });
    res.json({ success: true, data });
  } catch (error) {
    return respondWithError(res, error, { status: 500, message: 'Could not load the codes.' });
  }
});

router.post('/:id/codes', requirePermission('offer:update'), async (req: Request, res: Response) => {
  try {
    const data = await offerService.makeCodes(clientOf(req), String(req.params.id), String(req.body?.prefix ?? ''), Number(req.body?.count));
    res.status(201).json({ success: true, data });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not make the codes.' });
  }
});

/**
 * Start, pause or retire.
 *
 * One route rather than three, because they are one decision with three answers and the guards
 * are identical. Archiving needs its own permission: it is the only one that cannot be undone.
 */
router.post('/:id/status', requirePermission('offer:update'), async (req: Request, res: Response) => {
  try {
    const next = String(req.body?.status ?? '').toUpperCase();
    if (!['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(next)) {
      return res.status(400).json({
        success: false,
        message: 'An offer can be started, paused or retired. Nothing else.'
      });
    }

    if (next === 'ARCHIVED') {
      // Asked through grants(), as requirePermission asks, rather than a raw includes(): the
      // catalogue is where implication lives, and a hand-rolled check is how a second, slightly
      // different idea of "has permission" gets into the codebase.
      const user = (req as any).user;
      if (!holdsEverything(user?.permissions, user?.roles) && !grants(user?.permissions ?? [], 'offer:archive')) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to retire an offer.'
        });
      }
    }

    const offer = await offerService.setStatus(clientOf(req), String(req.params.id), next as any, userOf(req));
    res.json({ success: true, data: offer });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not change that offer.' });
  }
});

// ── Shopify ─────────────────────────────────────────────────────────────────────────────────────
//
// Reading the state needs only offer:view. Everything that changes what a live Shopify store
// charges needs offer:publish_external -- and accepting Shopify's version also needs offer:update,
// because it rewrites the offer here.

const apiFor = (installation: { id: string; shopDomain: string }) => adminApiFor(installation.id, installation.shopDomain);

router.get('/:id/shopify', requirePermission('offer:view'), async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await offerMirrorService.overview(clientOf(req), String(req.params.id)) });
  } catch (error) {
    return respondWithError(res, error, { status: 500, message: 'Could not read this offer\'s Shopify copy.' });
  }
});

router.post('/:id/shopify', requirePermission('offer:publish_external'), async (req: Request, res: Response) => {
  try {
    await offerMirrorService.enable(clientOf(req), String(req.params.id), userOf(req));
    res.status(202).json({ success: true, data: await offerMirrorService.overview(clientOf(req), String(req.params.id)) });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not put this offer on Shopify.' });
  }
});

router.delete('/:id/shopify', requirePermission('offer:publish_external'), async (req: Request, res: Response) => {
  try {
    await offerMirrorService.disable(clientOf(req), String(req.params.id));
    res.status(202).json({ success: true, data: await offerMirrorService.overview(clientOf(req), String(req.params.id)) });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not take this offer off Shopify.' });
  }
});

router.post('/:id/shopify/push', requirePermission('offer:publish_external'), async (req: Request, res: Response) => {
  try {
    await offerMirrorService.pushOurs(clientOf(req), String(req.params.id));
    res.status(202).json({ success: true, data: await offerMirrorService.overview(clientOf(req), String(req.params.id)) });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not push this offer to Shopify.' });
  }
});

router.post('/:id/shopify/accept', requirePermission('offer:publish_external'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!holdsEverything(user?.permissions, user?.roles) && !grants(user?.permissions ?? [], 'offer:update')) {
      return res.status(403).json({
        success: false,
        message: 'Accepting Shopify\'s version changes this offer, which you do not have permission to do.'
      });
    }
    await offerMirrorService.acceptTheirs(clientOf(req), String(req.params.id), userOf(req), apiFor);
    res.json({ success: true, data: await offerMirrorService.overview(clientOf(req), String(req.params.id)) });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not accept the Shopify version.' });
  }
});

export default router;
