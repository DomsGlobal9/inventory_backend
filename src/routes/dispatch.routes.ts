import { Router } from 'express';
import { createDispatch } from '../controllers/dispatch.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(requireAuth);
router.use(tenantMiddleware);

router.post('/', requirePermission('dispatch:create'), createDispatch);

export default router;
