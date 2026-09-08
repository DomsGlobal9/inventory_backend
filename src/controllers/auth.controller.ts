import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { authCookieOptions, clearCookieOptions } from '../lib/cookies';
import { encryptCredential } from '../lib/credentialEncryption';

const userWithRolesInclude = {
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
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password, clientId } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Missing credentials' });
    }

    let user;

    if (clientId) {
      // Only reached when the frontend already knows which workspace to use --
      // either it remembered the visitor's last one, or the visitor just picked
      // one from the disambiguation step below.
      user = await prisma.user.findUnique({
        where: { clientId_email: { clientId, email } },
        include: userWithRolesInclude
      });
    } else {
      // The common path: a client admin just types their email and password, exactly
      // like any normal SaaS login -- no internal workspace ID required. `email` is
      // only unique *within* a client (see the `[clientId, email]` constraint), so the
      // same email can genuinely belong to more than one workspace; disambiguate by
      // password match, and only ask the visitor to choose in the rare case where more
      // than one of their workspaces shares both the same email and the same password.
      const candidates = await prisma.user.findMany({
        where: { email, status: 'ACTIVE' },
        include: userWithRolesInclude
      });

      const matches = [];
      for (const candidate of candidates) {
        if (await AuthService.comparePassword(password, candidate.password)) {
          matches.push(candidate);
        }
      }

      if (matches.length > 1) {
        return res.status(200).json({
          success: false,
          requiresWorkspaceSelection: true,
          message: 'This email is used in more than one workspace. Choose which one to sign into.',
          workspaces: matches.map(m => ({ clientId: m.clientId }))
        });
      }

      user = matches[0];
    }

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
      clientId: user.clientId
    });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), lastActiveAt: new Date() } });

    res.cookie('token', token, authCookieOptions);

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          // The tenant the session belongs to. /auth/session already exposed this (as
          // client.id) but login did not, so a freshly logged-in client had no way to know
          // its own tenant until a page reload -- which is why image upload fell back to a
          // hardcoded VITE_CLIENT_ID build constant instead.
          clientId: user.clientId,
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

export const logout = async (req: Request, res: Response) => {
  // Must match the attributes the cookie was set with, or the browser keeps it.
  res.clearCookie('token', clearCookieOptions);
  res.json({ success: true, message: 'Logged out successfully' });
};

// Self-service, name only. Deliberately NOT password, role, or status -- passwords for a
// client's staff are set once by a Super Admin/Admin (auto-generated or custom) and stay
// permanent; only Team & Users (team.controller.ts, gated by `admin:users`) can ever change
// one, and role/status changes go through that same admin-only flow to avoid a
// privilege-escalation bug where a user edits their own access level.
export const updateMyProfile = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { name } = req.body;

    const data: { name?: string } = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const updated = await prisma.user.update({ where: { id: authUser.id }, data });
    res.json({ success: true, data: { id: updated.id, name: updated.name, email: updated.email } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to update profile', error: error.message });
  }
};

export const session = async (req: Request, res: Response) => {
  try {
    // Expecting requireAuth middleware to have populated req.user
    const user = (req as any).user;
    
    if (!user) {
      return res.status(401).json({ success: false, authenticated: false });
    }

    res.json({
      success: true,
      authenticated: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roles: user.roles, // from normalized req.user (UserWithRoles.roles is the array field — there is no singular `role`)
        permissions: user.permissions // Treated purely as Inventory RBAC, not module entitlements
      },
      client: {
        id: user.clientId
      },
      modules: ['inventory'] // Mocked entitlement. In Phase 4, Gateway or Super Admin sets this.
    });
  } catch (error: any) {
    res.status(500).json({ success: false, authenticated: false });
  }
};

/**
 * Lets a Super Admin change their OWN password.
 *
 * The only self-service password change in the product, and deliberately so. Everyone else's
 * password is set for them by a Super Admin or Admin and stays permanent -- a shop assistant
 * who changes their own leaves nobody able to help them back in. The owner is different: they
 * have no one above them to reset it.
 *
 * The current password is required. A session left open on a shop-floor machine is otherwise
 * enough to lock the owner out of their own workspace.
 *
 * BOTH stored copies are updated together, in one write. The bcrypt hash is what login checks;
 * the encrypted copy is what the platform console and the Team screen show when someone asks
 * to see it. Updating one without the other leaves the console confidently displaying a
 * password that no longer works -- worse than showing nothing, because the person reading it
 * has no reason to doubt it.
 */
export const changeMyPassword = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { currentPassword, newPassword } = req.body ?? {};

    const roles: string[] = authUser?.roles ?? [];
    if (!roles.includes('SUPER_ADMIN')) {
      return res.status(403).json({
        success: false,
        message: 'Only a Super Admin can change their own password. Ask an admin to set yours.'
      });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'The new password must be at least 8 characters' });
    }
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ success: false, message: 'Enter your current password' });
    }

    const user = await prisma.user.findUnique({ where: { id: authUser.id } });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });

    const matches = await AuthService.comparePassword(currentPassword, user.password);
    if (!matches) {
      return res.status(401).json({ success: false, message: 'That is not your current password' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, message: 'The new password is the same as the current one' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await AuthService.hashPassword(newPassword),
        passwordEncrypted: encryptCredential(newPassword)
      }
    });

    // Not emailed. The person who changed it is the person holding it, and mailing a password
    // to someone who just typed it adds a copy in an inbox for no benefit.
    res.json({ success: true, data: { changed: true } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to change the password', error: error.message });
  }
};
