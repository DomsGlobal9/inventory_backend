import { Router } from 'express';
import {
  createCustomer,
  getCustomers,
  getCustomerById,
  updateCustomer
} from '../controllers/customer.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { serviceAuthMiddleware } from '../middleware/serviceAuth.middleware';

const router = Router();

router.use(requireAuth);
router.use(tenantMiddleware);

// Strict service-to-service ingestion endpoint
router.post('/', serviceAuthMiddleware, createCustomer);

router.get('/', requirePermission('customer:view'), getCustomers);
router.get('/:id', requirePermission('customer:view'), getCustomerById);
router.patch('/:id', requirePermission('customer:update'), updateCustomer);

export default router;
