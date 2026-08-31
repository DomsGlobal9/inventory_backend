import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Check for Service-to-Service bypass
    const serviceKey = req.headers['x-internal-service-key'];
    const VALID_KEY = process.env.INTERNAL_SERVICE_KEY || 'development_secret_key_123';
    if (serviceKey && serviceKey === VALID_KEY) {
      (req as any).isServiceRequest = true;
      return next();
    }

    // 2. Standard JWT User Authentication
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = AuthService.verifyToken(token);
    
    // Attach decoded user info to request
    (req as any).user = decoded;
    
    // For backwards compatibility and tenant isolation
    (req as any).clientId = decoded.clientId;
    
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or expired token' });
  }
};
