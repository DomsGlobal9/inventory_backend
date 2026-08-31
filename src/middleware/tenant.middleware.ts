import { Request, Response, NextFunction } from 'express';

export const tenantMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // If requireAuth middleware ran first, use the verified clientId from the JWT
  let clientId = (req as any).user?.clientId;

  // Fallback to header for routes not yet protected by requireAuth
  if (!clientId) {
    clientId = req.headers['x-client-id'] as string;
  }

  if (!clientId) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing tenant context (clientId)'
    });
  }

  // Inject into request object for controllers to use
  (req as any).clientId = clientId;
  
  const locationId = req.headers['x-location-id'] as string | undefined;
  if (locationId) {
    (req as any).locationId = locationId;
  }

  next();
};
