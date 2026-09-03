import { Router } from 'express';
import { login, logout, session, updateMyProfile } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.post('/login', login);
router.post('/logout', logout);
router.get('/session', authenticate, session);
router.patch('/me', authenticate, updateMyProfile);

export default router;
