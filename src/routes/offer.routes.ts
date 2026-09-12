import { Router, Request, Response } from 'express';
import { offerService } from '../services/offers';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { respondWithError } from '../utils/respondWithError';

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
    res.json({ success: true, data: offers });
  } catch (error) {
    return respondWithError(res, error, { status: 500, message: 'Could not load the offers.' });
  }
});

router.get('/:id', requirePermission('offer:view'), async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await offerService.getById(clientOf(req), String(req.params.id)) });
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
      const permissions: string[] = (req as any).user?.permissions ?? [];
      if (!permissions.includes('*') && !permissions.includes('offer:archive')) {
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

export default router;
