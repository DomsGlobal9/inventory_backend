import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import * as appKeys from '../services/shop-app-keys';
import { verifyServiceToken } from '../middleware/service.middleware';

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
/**
 * The Boutique app's own signed pass (26 Nov 2026, the owner: "make it automatic"): the same pass it already sends to
 * the boutique API (RS256, its own key, scope modules:boutique, its boutique account inside). Nothing to make or hand
 * over; the boutique is signed into the pass, so it can never name another. A partner app key still works (any other
 * app, or the Boutique app until it switches).
 */
function boutiquePass(req: Request, res: Response): Promise<{ id: string; name: string; tenant: string } | 'refused' | null> {
  const auth = req.get('authorization') ?? '';
  if (req.get('x-shop-app-key') || !/^Bearer\s+\S+/.test(auth)) return Promise.resolve(null);
  return new Promise(resolve => {
    // verifyServiceToken answers a bad pass itself (401/403) and never calls next then.
    const watch = Object.create(res);
    watch.status = (code: number) => { resolve('refused'); return res.status(code); };
    verifyServiceToken(req, watch, () => {
      const s: any = (req as any).service;
      if (!s?.scopes?.includes('modules:boutique') || typeof s.tenant !== 'string') {
        res.status(403).json({ success: false, message: 'This pass is not the Boutique app\'s (needs modules:boutique and its boutique account).' });
        return resolve('refused');
      }
      resolve({ id: `pass:${s.issuer ?? s.id}`, name: 'Boutique app', tenant: String(s.tenant).toLowerCase() });
    });
  });
}

export async function shopV1Gate(req: Request, res: Response, next: NextFunction) {
  try {
    const pass = await boutiquePass(req, res);
    if (pass === 'refused') return;
    let checked: { ok: true; app: { id: string; name: string; tenant: string } } | { ok: false; why: string };
    if (pass) checked = { ok: true, app: pass };
    else {
      checked = await appKeys.check(req.get('x-shop-app-key'));
      if (!checked.ok) return res.status(401).json({ success: false, message: `${checked.why} The Boutique app sends its own signed pass instead (Authorization: Bearer).` });
    }
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
