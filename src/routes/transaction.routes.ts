import { Router } from 'express';
import { transactionController } from '../controllers/transaction.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

router.post('/', transactionController.create);
router.get('/', transactionController.getAll);

export default router;
