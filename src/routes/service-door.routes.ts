import { Router, Request, Response, NextFunction } from 'express';
import { verifyServiceToken } from '../middleware/service.middleware';
import { grants } from '../config/permissions';
import { doorAuth } from '../services/service-door/auth';
import { AREAS, matchRoute } from '../services/service-door/catalogue';
import { openApi } from '../services/service-door/openapi';

/**
 * /api/v1/service -- Inventory's features for other ScaleEzy modules (services/service-door). The health check and
 * the menu are open; everything else needs a module's signed pass and goes through the app's own routes, limited
 * to the published list.
 */
const router = Router();
const noRoute = (req: Request, res: Response) =>
  res.status(404).json({ success: false, message: `There is no service route ${req.method} /api/v1/service${req.originalUrl.split('?')[0].replace(/^.*\/api\/v1\/service/, '')}. See /api/v1/service/openapi.json.` });

router.get('/health', (_req, res) => res.json({ success: true, service: 'inventory', api: 'service', version: 1 }));
router.get('/openapi.json', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/api/v1/service`;
  res.json(openApi(base));
});

router.use(verifyServiceToken, doorAuth);

for (const area of AREAS) {
  const { router: appRouter, before = [] } = area.load();
  router.use(area.at, (req: Request, res: Response, next: NextFunction) => {
    const route = matchRoute(area, req.method, req.path);
    if (!route) return noRoute(req, res);
    const user = (req as any).user;
    if (!grants(user.permissions ?? [], route.scope)) {
      return res.status(403).json({ success: false, message: `This module's pass does not hold ${route.scope}, which ${area.title.toLowerCase()} needs.`, requiredPermission: route.scope });
    }
    next();
  }, ...before, appRouter);
}

router.use(noRoute);

export default router;
