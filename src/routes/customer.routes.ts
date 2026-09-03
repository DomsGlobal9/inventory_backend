import { Router } from 'express';
import {
  createCustomer,
  getCustomers,
  getCustomerById,
  updateCustomer
} from '../controllers/customer.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

// Customer ingestion endpoint
router.post('/', requirePermission('customer:create'), createCustomer);

router.get('/', requirePermission('customer:view'), getCustomers);
router.get('/:id', requirePermission('customer:view'), getCustomerById);
router.patch('/:id', requirePermission('customer:update'), updateCustomer);

export default router;
