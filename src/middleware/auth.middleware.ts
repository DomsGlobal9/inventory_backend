import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { prisma } from '../lib/prisma';

export interface UserWithRoles {
  id: string;
  clientId: string;
  name?: string;
  email?: string;
  roles: string[];
  permissions: string[];
}

export const verifyLocalAssertion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // The x-internal-service-key bypass that used to sit here has been removed. It set
    // `req.isServiceRequest = true` and called next() WITHOUT populating `req.user` --
    // and nothing in the entire codebase ever read that flag. Routes behind
    // tenantMiddleware/requirePermission then 401'd on the missing identity, but
    // /support-tickets has neither guard and dereferenced `user.clientId` straight into
    // an uncaught TypeError, i.e. a header-only path past authentication.
    // Service-to-service traffic already has a real, scoped home: /api/v1/internal,
    // guarded by verifyServiceToken, which sets an actual `req.service` principal.

    // Local Auth Mode (Phase 1 & 2.5)
    let token = req.cookies?.token;
    
    // Explicit Fallback for CLI, internal API clients, and automated testing ONLY. 
    // The browser frontend should never use this fallback.
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing session token' });
    }

    const decoded = AuthService.verifyToken(token);
    
    // 3. Dynamic Identity Verification & RBAC Loading
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      include: {
        roles: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } }
            }
          }
        }
      }
    });

    if (!user || user.status !== 'ACTIVE' || user.clientId !== decoded.clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid identity or inactive user' });
    }

    // Extract dynamic roles and permissions
    const roles = user.roles.map((ur: any) => ur.role.name);
    const permissions = Array.from(
      new Set(
        user.roles.flatMap((ur: any) =>
          ur.role.permissions.map((rp: any) => rp.permission.key)
        )
      )
    );

    // 4. Strict Normalized Identity Contract
    const normalizedUser: UserWithRoles = {
      id: user.id,
      clientId: user.clientId,
      name: user.name,
      email: user.email,
      roles: roles,
      permissions: permissions
    };
    (req as any).user = normalizedUser;
    
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or expired token' });
  }
};

import { verifyGatewayAssertion } from './gateway.middleware';
import { env } from '../config/env';

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  // Reject Service JWTs from human authentication routes explicitly
  const authHeader = req.headers.authorization || '';
  if (authHeader.includes('inventory-service') || req.headers['x-is-service-account']) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Service JWTs cannot be used for human routes' });
  }

  if (env.AUTH_MODE === 'gateway') {
    return verifyGatewayAssertion(req, res, next);
  } else {
    return verifyLocalAssertion(req, res, next);
  }
};
