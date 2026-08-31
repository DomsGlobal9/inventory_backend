import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to strictly authorize backend-to-backend communication.
 * Validates the presence of a correct INTERNAL_SERVICE_KEY header.
 */
export const serviceAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const serviceKey = req.headers['x-internal-service-key'];
  
  // Hardcoded or from ENV
  const VALID_KEY = process.env.INTERNAL_SERVICE_KEY || 'development_secret_key_123';

  if (!serviceKey || serviceKey !== VALID_KEY) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'This endpoint is restricted to authorized internal services only.'
    });
  }

  next();
};
