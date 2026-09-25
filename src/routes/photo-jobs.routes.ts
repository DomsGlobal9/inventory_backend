import { Router } from 'express';
import { photoJobsController } from '../controllers/photo-jobs.controller';
import { requirePermission } from '../middleware/permission.middleware';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

/*
 * Two permissions, on purpose.
 *
 * Starting or stopping a generation spends the shop's paid allowance, so it needs the same
 * capability the streaming endpoint needs: tryon:generate.
 *
 * Looking at one does not spend anything. Anyone who may see the product may see what is being
 * made for it -- the person who pressed the button may have gone home, and the shop still needs
 * to know whether its photographs are coming.
 */
router.post('/', requirePermission('tryon:generate'), photoJobsController.create.bind(photoJobsController));
router.post('/:id/cancel', requirePermission('tryon:generate'), photoJobsController.cancel.bind(photoJobsController));

router.get('/', requirePermission('product:view'), photoJobsController.list.bind(photoJobsController));
router.get('/notices', requirePermission('product:view'), photoJobsController.notices.bind(photoJobsController));
router.post('/seen', requirePermission('product:view'), photoJobsController.seen.bind(photoJobsController));

export default router;
