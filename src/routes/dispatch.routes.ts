import { Router } from 'express';
import { createDispatch } from '../controllers/dispatch.controller';

const router = Router();

router.post('/', createDispatch);

export default router;
