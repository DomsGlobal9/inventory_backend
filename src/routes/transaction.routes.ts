import { Router } from 'express';
import { transactionController } from '../controllers/transaction.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

// This is the legacy direct-mutation path (bypasses inventoryMutationService — see
// transaction.repository.ts). It was previously reachable by ANY authenticated user
// regardless of role, which meant a SALES-only account could mutate real stock
// quantities with zero inventory permission. Gate it the same as the real
// stock-in/out/adjustment endpoints until it's either removed or unified with them.
router.post('/', requirePermission('inventory:adjust'), transactionController.create);
router.get('/', requirePermission('inventory:view'), transactionController.getAll);

export default router;
