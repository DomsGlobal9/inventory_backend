import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import * as appKeys from '../services/shop-app-keys';

/**
 * The door to Shop API v1 (/shop/v1/<shop>/..., 20 Nov 2026, PLAN-shop-api.md).
 *
 * v1 runs the SAME routes as our own online shop (routes/shop-public.routes.ts), so it can never drift from it; this
 * gate is the only difference:
 *   - every call carries a partner app key (X-Shop-App-Key) that ScaleEzy made and has not switched off;
 *   - the key reaches only the shops linked to its boutique account -- another shop is "not found", never served;
 *   - the shop's own Online shop switch still decides whether it sells (the routes check that, as always);
 *   - req.shopApp names the app, so an order placed here is marked as the app's and our shopper messages stay quiet
 *     (the Boutique app sends its own).
 * Addresses that are not one shop's (`/_look/...`, a look code that may belong to any shop) are not part of v1.
 */
export async function shopV1Gate(req: Request, res: Response, next: NextFunction) {
  try {
    const checked = await appKeys.check(req.get('x-shop-app-key'));
    if (!checked.ok) return res.status(401).json({ success: false, message: checked.why });
    const slug = decodeURIComponent(req.path.split('/')[1] ?? '').trim().toLowerCase();
    if (!slug || slug.startsWith('_') || slug.length > 40) return res.status(404).json({ success: false, message: 'Name the shop: /shop/v1/<shop>/...' });
    // The Boutique app's one key for every boutique (26 Nov 2026) names, on each call, the boutique it is calling for;
    // the shop must be that boutique's. A mix-up in the app can then never order in another boutique's shop.
    let tenant = checked.app.tenant;
    if (tenant === appKeys.ALL) {
      tenant = String(req.get('x-boutique-tenant') ?? '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(tenant)) return res.status(400).json({ success: false, message: 'Name the boutique you are calling for in X-Boutique-Tenant (its tenant).' });
    }
    const shop = await prisma.onlineShop.findUnique({ where: { slug }, select: { clientId: true } });
    // Not this boutique's shop, or no shop at all: the same answer, so a key cannot be used to find out which exist.
    if (!shop || !(await appKeys.shopIsTenants(shop.clientId, tenant))) {
      return res.status(404).json({ success: false, message: 'There is no shop at this address for this app.' });
    }
    (req as any).shopApp = { ...checked.app, tenant };
    next();
  } catch (e) { next(e); }
}
