import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { prisma } from '../lib/prisma';

export interface PlatformAdminIdentity {
  id: string;
  name: string;
  email: string;
}

// Guards every /api/v1/admin/* route. Deliberately separate from `authenticate` --
// a platform admin is not a `User` row and carries no `clientId`, so it must never be
// able to fall through into tenant-scoped routes via this cookie.
export const verifyPlatformAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.platform_admin_token;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing platform admin session' });
    }

    const decoded = AuthService.verifyPlatformAdminToken(token);

    const admin = await prisma.platformAdmin.findUnique({ where: { id: decoded.sub } });

    if (!admin || admin.status !== 'ACTIVE') {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or inactive platform admin' });
    }

    (req as any).platformAdmin = { id: admin.id, name: admin.name, email: admin.email } as PlatformAdminIdentity;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or expired platform admin session' });
  }
};
