import { Request, Response, NextFunction } from 'express';

export const tenantMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // In a real scenario, clientId comes from JWT claims decoded by an auth middleware.
  // We simulate it here being extracted from headers or JWT.
  const clientId = req.headers['x-client-id'] as string;

  if (!clientId) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing tenant context (clientId)'
    });
  }

  // Inject into request object for controllers to use
  (req as any).clientId = clientId;

  next();
};
