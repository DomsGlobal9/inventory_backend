import { Request, Response, NextFunction, RequestHandler } from 'express';
import { prisma } from '../lib/prisma';

export const requirePermission = (requiredPermission: string): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      
      if (!user || !user.userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized: User context missing' });
      }

      // SUPER_ADMIN bypasses all checks
      if (user.roles && user.roles.includes('SUPER_ADMIN')) {
        return next();
      }

      if (!user.permissions || !user.permissions.includes(requiredPermission)) {
        return res.status(403).json({ 
          success: false, 
          message: `Forbidden: Missing required permission [${requiredPermission}]` 
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Internal server error checking permissions' });
    }
  };
};

export const requireRole = (requiredRole: string): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      
      if (!user || !user.userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized: User context missing' });
      }

      // SUPER_ADMIN bypasses all checks
      if (user.roles && user.roles.includes('SUPER_ADMIN')) {
        return next();
      }

      if (!user.roles || !user.roles.includes(requiredRole)) {
        return res.status(403).json({ 
          success: false, 
          message: `Forbidden: Missing required role [${requiredRole}]` 
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Internal server error checking roles' });
    }
  };
};
