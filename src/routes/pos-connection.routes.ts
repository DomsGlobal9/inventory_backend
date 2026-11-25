import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { posSwitchConfigured, status as posStatus } from '../services/pos-switch';

/**
 * Settings → POS (billing counter): what the shop sees of its POS.
 *
 * Since 25 Nov 2026 nothing about POS is done by hand (the owner: "the key shouldn't be added by the owner, nothing
 * manual, all automatic"). ScaleEzy's POS switch -- the Platform Console, or the Boutique app's switch -- makes the till
 * key and hands it to POS; switching on again hands over a fresh one. The shop only reads: whether POS is on, where to
 * bill, its counters and the bills left out. Making, replacing or disconnecting a key here is refused in words.
 *
 * Same permission as Connected websites (admin:locations).
 */
const router = Router();
router.use(tenantMiddleware);

const PERMISSION = 'admin:locations';
const clientOf = (req: Request) => (req as any).clientId as string;

function fail(res: Response, error: any, next: NextFunction) {
  if (error?.statusCode) {
    res.status(error.statusCode).json({ success: false, message: error.message });
    return;
  }
  next(error);
}

/*
 * Which stores bill at a till. For the people who could ring up a sale here -- their screen needs
 * it to decide whether to offer New sale -- and not for those who manage keys only. It is NOT open
 * to every signed-in user: somebody whose role grants nothing has no New sale to hide, so no reason
 * to be told, and the security audit holds every read to that.
 */
router.get('/billing-locations', requirePermission('sales_order:counter_sale'), async (req, res, next) => {
  try {
    res.json({ success: true, data: { locationIds: await posConnectionService.billingLocationIds(clientOf(req)) } });
  } catch (error) { fail(res, error, next); }
});

/*
 * Is POS on for this shop? Only then does anything about POS show in Inventory. `managed`: ScaleEzy switched it on.
 * A shop connected by hand before the switch existed still sees its section while it has a till key that works --
 * unless POS says it is switched off. POS out of reach: answered from the keys alone, never an error page.
 */
router.get('/state', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    const clientId = clientOf(req);
    const handTills = (await posConnectionService.list(clientId)).filter(t => t.status === 'ACTIVE').length;
    let pos: Record<string, any> | null = null;
    if (posSwitchConfigured()) { try { pos = await posStatus(clientId) as any; } catch { pos = null; } }
    const managed = pos?.posOn === true;
    const switchedOff = pos?.posOn === false && !!pos?.shop;
    res.json({ success: true, data: {
      show: managed || (!switchedOff && handTills > 0),
      managed,
      posAddress: managed ? pos?.posAddress ?? null : null,
      ownerSignsInWith: managed ? pos?.owner?.signInWith ?? null : null,
      shopName: managed ? pos?.shop?.name ?? null : null
    } });
  } catch (error) { fail(res, error, next); }
});

router.get('/', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    res.json({ success: true, data: await posConnectionService.list(clientOf(req)) });
  } catch (error) { fail(res, error, next); }
});

router.get('/left-out', requirePermission(PERMISSION), async (req, res, next) => {
  try {
    res.json({ success: true, data: await posConnectionService.leftOut(clientOf(req)) });
  } catch (error) { fail(res, error, next); }
});

// Nothing by hand: refused in words, after the permission check, so who-may stays exactly as before.
const BY_SCALEEZY = 'POS is switched on by ScaleEzy, and its till keys are made and changed automatically. Contact ScaleEzy to add a counter, change its key or turn POS off.';
const automaticOnly = (_req: Request, res: Response) => { res.status(409).json({ success: false, message: BY_SCALEEZY }); };
router.post('/', requirePermission(PERMISSION), automaticOnly);
router.post('/:id/replace-key', requirePermission(PERMISSION), automaticOnly);
router.post('/:id/disconnect', requirePermission(PERMISSION), automaticOnly);

export default router;
