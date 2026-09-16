import { Router } from 'express';
import {
  createCustomer,
  getCustomerByPhone,
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
// Before /:id, which would otherwise take "by-phone" as a customer id.
router.get('/by-phone/:phone', requirePermission('customer:view'), getCustomerByPhone);
router.get('/:id', requirePermission('customer:view'), getCustomerById);
router.patch('/:id', requirePermission('customer:update'), updateCustomer);

export default router;
