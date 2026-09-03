import { Router } from 'express';
import { reportClientError } from '../controllers/client-error.controller';

const router = Router();
router.post('/', reportClientError);

export default router;
