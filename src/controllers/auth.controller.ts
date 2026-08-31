import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password, clientId } = req.body;

    if (!email || !password || !clientId) {
      return res.status(400).json({ success: false, message: 'Missing credentials' });
    }

    const user = await prisma.user.findUnique({
      where: {
        clientId_email: {
          clientId,
          email
        }
      },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true }
                }
              }
            }
          }
        }
      }
    });

    if (!user || user.status !== 'ACTIVE') {
      return res.status(401).json({ success: false, message: 'Invalid credentials or inactive user' });
    }

    const isValidPassword = await AuthService.comparePassword(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Extract role names and the flattened, deduplicated set of permission keys they grant
    const roles = user.roles.map((ur: any) => ur.role.name);
    const permissions = Array.from(
      new Set(
        user.roles.flatMap((ur: any) =>
          ur.role.permissions.map((rp: any) => rp.permission.key)
        )
      )
    );

    const token = AuthService.generateToken({
      userId: user.id,
      clientId: user.clientId,
      roles,
      permissions
    });

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          roles,
          permissions
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Login failed', error: error.message });
  }
};
