import { Router } from 'express';
import { verifyServiceToken } from '../middleware/service.middleware';

const router = Router();

router.use(verifyServiceToken);

// Simple route to test service identity and scopes
router.get('/test', (req: any, res) => {
  const service = req.service;

  // Simple scope enforcement for test 9 and 16
  const requiredScope = req.query.requiredScope as string;
  if (requiredScope && !service.scopes.includes(requiredScope)) {
    return res.status(403).json({ success: false, message: 'Forbidden: Missing required scope' });
  }

  // Cross-tenant check for test 15
  const targetClient = req.query.targetClient as string;
  if (targetClient && service.clientId !== targetClient) {
    return res.status(403).json({ success: false, message: 'Forbidden: Cross-tenant access denied' });
  }

  res.json({ success: true, service });
});

export default router;
