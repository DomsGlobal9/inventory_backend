import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { posConnectionService } from '../services/pos/pos-connection.service';

/**
 * Settings → POS (billing counter): the owner's side of a till key.
 *
 * Same permission as Connected websites (admin:locations): both hand out a key that reads the
 * catalogue and stock, and this one also writes sales, so it is not a lesser power.
 */
const router = Router();
router.use(tenantMiddleware);

const PERMISSION = 'admin:locations';

const createSchema = z.object({
  locationId: z.string({ required_error: 'Choose the stock location this counter sells from' })
    .uuid('Choose the stock location this counter sells from'),
  name: z.string().trim().max(80, 'Keep the name under 80 letters').optional()
});

const clientOf = (req: Request) => (req as any).clientId as string;

function fail(res: Response, error: any, next: NextFunction) {
  if (error?.statusCode) {
    res.status(error.statusCode).json({ success: false, message: error.message });
    return;
  }
  next(error);
}

router.get('/', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    res.json({ success: true, data: await posConnectionService.list(clientOf(req)) });
  } catch (error) { fail(res, error, next); }
});

router.post('/', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Check the form and try again.' });
      return;
    }
    const made = await posConnectionService.create(clientOf(req), parsed.data);
    res.status(201).json({ success: true, data: { ...made, keyIsShownOnce: true } });
  } catch (error) { fail(res, error, next); }
});

router.post('/:id/replace-key', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    const made = await posConnectionService.replaceKey(clientOf(req), String(req.params.id));
    res.json({ success: true, data: { ...made, keyIsShownOnce: true } });
  } catch (error) { fail(res, error, next); }
});

router.post('/:id/disconnect', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    res.json({ success: true, data: await posConnectionService.disconnect(clientOf(req), String(req.params.id)) });
  } catch (error) { fail(res, error, next); }
});

export default router;
