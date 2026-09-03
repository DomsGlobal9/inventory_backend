import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { UserWithRoles } from './auth.middleware';

let gatewayPublicKey: string | null = null;

const getGatewayPublicKey = (): string => {
  if (gatewayPublicKey) return gatewayPublicKey;
  if (!env.GATEWAY_PUBLIC_KEY_PATH) {
    throw new Error('GATEWAY_PUBLIC_KEY_PATH is not defined in environment');
  }
  const keyPath = path.resolve(process.cwd(), env.GATEWAY_PUBLIC_KEY_PATH);
  gatewayPublicKey = fs.readFileSync(keyPath, 'utf8');
  return gatewayPublicKey;
};

export const verifyGatewayAssertion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid Gateway token' });
    }

    const token = authHeader.split(' ')[1];
    const publicKey = getGatewayPublicKey();

    // 1. Verify Signature, Issuer, Audience, Expiration (and ideally kid if using JWKS)
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'scal_easy_gateway',
      audience: 'inventory'
    }) as jwt.JwtPayload;

    const { sub, clientId, principalType } = decoded;

    if (!sub || !clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing required claims (sub, clientId)' });
    }

    // Handle Synthetic Super Admin Context
    if (principalType === 'SUPER_ADMIN') {
      const normalizedUser: UserWithRoles = {
        id: sub,
        clientId: clientId,
        roles: ['PLATFORM_ADMIN'],
        permissions: [] // In a real implementation, you might explicitly define cross-domain read/write permissions here.
      };
      (req as any).user = normalizedUser;
      return next();
    }

    // 2. Load Local RBAC and enforce strict domain rules for normal tenant users
    const user = await prisma.user.findFirst({
      where: {
        id: sub,
        clientId: clientId,
        status: 'ACTIVE'
      },
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

    if (!user) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Local user inactive or tenant mismatch' });
    }

    // Normalize Roles and Permissions
    const roles: string[] = [];
    const permissionsSet = new Set<string>();

    user.roles.forEach(ur => {
      roles.push(ur.role.name);
      ur.role.permissions.forEach(rp => {
        permissionsSet.add(rp.permission.key);
      });
    });

    const normalizedUser: UserWithRoles = {
      id: user.id,
      clientId: user.clientId,
      name: user.name,
      email: user.email,
      roles,
      permissions: Array.from(permissionsSet)
    };

    (req as any).user = normalizedUser;
    
    next();
  } catch (error: any) {
    console.error('Gateway JWT verification failed:', error.message);
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid Gateway token' });
  }
};
