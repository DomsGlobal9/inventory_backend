import { Router } from 'express';
import { login, logout, session, updateMyProfile, changeMyPassword } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.post('/login', login);
router.post('/logout', logout);
router.get('/session', authenticate, session);
router.patch('/me', authenticate, updateMyProfile);
// The only self-service password change in the product -- a Super Admin has nobody above them
// to reset theirs. Everyone else's is set for them and stays permanent.
router.post('/me/password', authenticate, changeMyPassword);

export default router;
