import { Router } from 'express';
import { getSuppliers, getSupplierById, createSupplier, updateSupplier, deleteSupplier } from '../controllers/supplier.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

// Inject verified clientId into every supplier request
router.use(tenantMiddleware);

router.get('/', requirePermission('supplier:view'), getSuppliers);
router.get('/:id', requirePermission('supplier:view'), getSupplierById);
router.post('/', requirePermission('supplier:create'), createSupplier);
router.put('/:id', requirePermission('supplier:update'), updateSupplier);
router.delete('/:id', requirePermission('supplier:delete'), deleteSupplier);

export default router;
