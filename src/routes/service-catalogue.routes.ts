import { Router } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { serviceCredentialService, tryOnUsageService } from '../services/tryon';

/**
 * What a merchant may see about the platform services their workspace uses.
 *
 * Settings -> APIs & Services. It shows that Try-On is active, a masked fingerprint of the key
 * and how it is being used -- and it CANNOT show the key itself.
 *
 * That last part is enforced here rather than left to the screen. `describe()` reads only the
 * stored prefix and never decrypts, so there is no code path from this route to the key's
 * value. Leaving the value out of the markup would look identical and be worth nothing: anyone
 * can open the network tab.
 *
 * Behind tenantMiddleware, and deliberately NOT behind an admin permission. A shop assistant
 * asking "is try-on switched on" is a reasonable question, and the answer discloses nothing.
 */

const router = Router();
router.use(tenantMiddleware);

router.get('/', async (req, res, next) => {
  try {
    const clientId = (req as any).clientId as string;
    const tryOn = await serviceCredentialService.describe(clientId, 'CATALOG_TRYON');

    res.json({
      success: true,
      data: [
        {
          id: 'CATALOG_TRYON',
          name: 'Virtual Try-On',
          description: 'Generates four views of a garment from a single photograph.',
          // Active either on this shop's own key or on the platform's shared one. The merchant
          // does not need to know which, and saying so would invite a question they cannot act
          // on -- but the distinction is kept for the console.
          active: tryOn.configured || tryOn.usingSharedFallback,
          keyPrefix: tryOn.keyPrefix,
          managedBy: 'Scaleezy',
          lastUsedAt: tryOn.lastUsedAt
        }
      ]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * This workspace's own try-on usage.
 *
 * A merchant seeing their own consumption is the thing that makes an allowance fair: being
 * stopped by a number nobody showed you is the worst version of this feature. It carries no
 * key material at all -- only counts and a ceiling.
 */
router.get('/tryon-usage', async (req, res, next) => {
  try {
    const clientId = (req as any).clientId as string;
    res.json({ success: true, data: await tryOnUsageService.summary(clientId) });
  } catch (error) {
    next(error);
  }
});

export default router;
