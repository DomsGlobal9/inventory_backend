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

/**
 * The two try-on services, named for what the merchant actually gets.
 *
 * "Virtual Try-On" was fine when there was one. With two it is the ambiguous half of both
 * names, and the difference that matters is WHO uses it: staff listing a garment, or a
 * customer holding a phone.
 */
const SERVICES = [
  {
    id: 'CATALOG_TRYON' as const,
    name: '4-View Catalog Try-On',
    description: 'Turns one garment photograph into four catalogue views, from inside the app.'
  },
  {
    id: 'SHOPPER_TRYON' as const,
    name: 'Try-On',
    description: 'Customers scan the QR code on a garment and see themselves wearing it.'
  }
];

router.get('/', async (req, res, next) => {
  try {
    const clientId = (req as any).clientId as string;
    const described = await Promise.all(
      SERVICES.map(s => serviceCredentialService.describe(clientId, s.id))
    );

    res.json({
      success: true,
      data: SERVICES.map((service, i) => {
        const cred = described[i];
        return {
          id: service.id,
          name: service.name,
          description: service.description,
          // Active either on this shop's own key or on the platform's shared one. The merchant
          // does not need to know which, and saying so would invite a question they cannot act
          // on -- but the distinction is kept for the console.
          active: cred.configured || cred.usingSharedFallback,
          keyPrefix: cred.keyPrefix,
          managedBy: 'Scaleezy',
          lastUsedAt: cred.lastUsedAt
        };
      })
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
    // Defaults to the catalog service so the existing screen keeps working untouched; the
    // shopper figures are asked for by name.
    const service = req.query.service === 'SHOPPER_TRYON' ? 'SHOPPER_TRYON' : 'CATALOG_TRYON';
    res.json({ success: true, data: await tryOnUsageService.summary(clientId, undefined, service) });
  } catch (error) {
    next(error);
  }
});

export default router;
