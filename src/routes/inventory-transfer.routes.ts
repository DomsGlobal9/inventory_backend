import { Router } from 'express';
import { transferStock } from '../controllers/inventory-transfer.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

router.post('/', requirePermission('inventory:transfer'), transferStock);

export default router;
