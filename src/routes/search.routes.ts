import { Router } from 'express';
import { searchController } from '../controllers/search.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

router.get('/', searchController.search.bind(searchController));

export default router;
