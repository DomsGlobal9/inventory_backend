import { Router } from 'express';
import { getSuppliers, getSupplierById, createSupplier, updateSupplier, deleteSupplier } from '../controllers/supplier.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

// Inject verified clientId into every supplier request
router.use(tenantMiddleware);

router.get('/', getSuppliers);
router.get('/:id', getSupplierById);
router.post('/', createSupplier);
router.put('/:id', updateSupplier);
router.delete('/:id', deleteSupplier);

export default router;
