import { Router } from 'express';
import { stockCountController } from '../controllers/stock-count.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

router.get('/', stockCountController.getCounts);
router.post('/', stockCountController.createCount);
router.get('/:id', stockCountController.getCountById);
router.post('/:id/start', stockCountController.startCount);
router.put('/:id/items/:itemId', stockCountController.updateItemCount);
router.post('/:id/complete', stockCountController.completeCount);

export default router;
