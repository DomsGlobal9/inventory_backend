import { Router } from 'express';
import { login, logout, session, updateMyProfile, changeMyPassword, logoutOtherDevices, markTourSeen } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.post('/login', login);
router.post('/logout', logout);
router.get('/session', authenticate, session);
router.patch('/me', authenticate, updateMyProfile);
// The short tour of the app is shown once; this is the person saying they have had it.
router.post('/tour-seen', authenticate, markTourSeen);
// The only self-service password change in the product -- a Super Admin has nobody above them
// to reset theirs. Everyone else's is set for them and stays permanent.
router.post('/me/password', authenticate, changeMyPassword);
router.post('/me/sign-out-other-devices', authenticate, logoutOtherDevices);

export default router;
