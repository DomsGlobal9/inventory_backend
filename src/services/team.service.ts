import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from './auth.service';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';
import { buildUnifiedAuditFeed } from './audit-feed.service';

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe -- same scheme as onboarding
}

export class TeamService {
  async listMembers(clientId: string) {
    return prisma.user.findMany({
      where: { clientId },
      select: {
        id: true, name: true, email: true, status: true, lastActiveAt: true, lastLoginAt: true, createdAt: true,
        roles: { select: { role: { select: { id: true, name: true } } } }
      },
      orderBy: { createdAt: 'asc' }
    });
  }

  async listRoles(clientId: string) {
    return prisma.role.findMany({ where: { clientId }, select: { id: true, name: true, description: true }, orderBy: { name: 'asc' } });
  }

  // Same merged feed the Platform Console sees, scoped to just this client -- so their own
  // admin doesn't need Scaleezy staff to look something up on their behalf.
  async listActivity(clientId: string) {
    return buildUnifiedAuditFeed({ clientId, limit: 30 });
  }

  private async countActiveSuperAdmins(clientId: string, excludeUserId?: string) {
    return prisma.user.count({
      where: {
        clientId,
        status: 'ACTIVE',
        id: excludeUserId ? { not: excludeUserId } : undefined,
        roles: { some: { role: { name: 'SUPER_ADMIN' } } }
      }
    });
  }

  // Super Admin outranks Admin: an Admin can manage every other role, but never touch a
  // Super Admin's role, status, or password. Only another Super Admin can.
  private async assertCanManageTarget(clientId: string, targetUserId: string, requesterIsSuperAdmin: boolean) {
    if (requesterIsSuperAdmin) return;
    const target = await prisma.user.findFirst({
      where: { id: targetUserId, clientId },
      include: { roles: { include: { role: true } } }
    });
    if (target?.roles.some(ur => ur.role.name === 'SUPER_ADMIN')) {
      throw Object.assign(new Error('Only a Super Admin can manage another Super Admin\'s account'), { statusCode: 403 });
    }
  }

  async inviteMember(params: {
    clientId: string; name: string; email: string; roleId: string; customPassword?: string; requesterIsSuperAdmin: boolean;
  }) {
    const role = await prisma.role.findUnique({ where: { id: params.roleId } });
    if (!role || role.clientId !== params.clientId) {
      throw Object.assign(new Error('Role not found'), { statusCode: 404 });
    }
    if (role.name === 'SUPER_ADMIN' && !params.requesterIsSuperAdmin) {
      throw Object.assign(new Error('Only a Super Admin can grant the Super Admin role'), { statusCode: 403 });
    }
    if (params.customPassword && params.customPassword.length < 6) {
      throw Object.assign(new Error('Password must be at least 6 characters'), { statusCode: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { clientId_email: { clientId: params.clientId, email: params.email } } });
    if (existing) {
      throw Object.assign(new Error('A team member with this email already exists'), { statusCode: 409 });
    }

    const finalPassword = params.customPassword || generateTempPassword();
    const [hashed, passwordEncrypted] = await Promise.all([
      AuthService.hashPassword(finalPassword),
      Promise.resolve(encryptCredential(finalPassword))
    ]);

    const user = await prisma.user.create({
      data: { clientId: params.clientId, name: params.name, email: params.email, password: hashed, passwordEncrypted, status: 'ACTIVE' }
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

    return { id: user.id, name: user.name, email: user.email, role: role.name, password: finalPassword };
  }

  async updateMemberRole(params: { clientId: string; userId: string; roleId: string; requesterIsSuperAdmin: boolean }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin);

    const role = await prisma.role.findUnique({ where: { id: params.roleId } });
    if (!role || role.clientId !== params.clientId) {
      throw Object.assign(new Error('Role not found'), { statusCode: 404 });
    }
    if (role.name === 'SUPER_ADMIN' && !params.requesterIsSuperAdmin) {
      throw Object.assign(new Error('Only a Super Admin can grant the Super Admin role'), { statusCode: 403 });
    }

    const target = await prisma.user.findFirst({
      where: { id: params.userId, clientId: params.clientId },
      include: { roles: { include: { role: true } } }
    });
    if (!target) throw Object.assign(new Error('Team member not found'), { statusCode: 404 });

    const targetIsSuperAdmin = target.roles.some(ur => ur.role.name === 'SUPER_ADMIN');
    if (targetIsSuperAdmin && role.name !== 'SUPER_ADMIN') {
      const remaining = await this.countActiveSuperAdmins(params.clientId, params.userId);
      if (remaining === 0) {
        throw Object.assign(new Error('This is the only Super Admin on the account -- promote someone else first'), { statusCode: 409 });
      }
    }

    // A client user has exactly one role in this schema's actual usage (onboarding and
    // this invite flow both assign exactly one) -- replace rather than accumulate.
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: params.userId } }),
      prisma.userRole.create({ data: { userId: params.userId, roleId: role.id } })
    ]);

    return { id: target.id, role: role.name };
  }

  async setMemberStatus(params: { clientId: string; userId: string; status: 'ACTIVE' | 'INACTIVE'; requesterUserId: string; requesterIsSuperAdmin: boolean }) {
    if (params.userId === params.requesterUserId) {
      throw Object.assign(new Error('You cannot deactivate your own account'), { statusCode: 400 });
    }
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin);

    const target = await prisma.user.findFirst({
      where: { id: params.userId, clientId: params.clientId },
      include: { roles: { include: { role: true } } }
    });
    if (!target) throw Object.assign(new Error('Team member not found'), { statusCode: 404 });

    const targetIsSuperAdmin = target.roles.some(ur => ur.role.name === 'SUPER_ADMIN');
    if (targetIsSuperAdmin && params.status !== 'ACTIVE') {
      const remaining = await this.countActiveSuperAdmins(params.clientId, params.userId);
      if (remaining === 0) {
        throw Object.assign(new Error('This is the only active Super Admin on the account'), { statusCode: 409 });
      }
    }

    return prisma.user.update({ where: { id: params.userId }, data: { status: params.status } });
  }

  // Decrypts and returns the team member's CURRENT password, so an admin can re-share it on
  // request without generating a new one. Deliberately explicit and on-demand (never
  // returned as part of listMembers) -- viewing a password is a meaningful action worth its
  // own audit trail entry, not a side effect of loading a list.
  async viewMemberPassword(params: { clientId: string; userId: string; requesterIsSuperAdmin: boolean }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin);

    const target = await prisma.user.findFirst({ where: { id: params.userId, clientId: params.clientId } });
    if (!target) throw Object.assign(new Error('Team member not found'), { statusCode: 404 });
    if (!target.passwordEncrypted) {
      throw Object.assign(new Error('No viewable password on file for this account -- set a new one instead'), { statusCode: 404 });
    }

    return { id: target.id, name: target.name, email: target.email, password: decryptCredential(target.passwordEncrypted) };
  }

  // Sets a permanent password (auto-generated or admin-chosen) -- replaces the old
  // "temporary password that forces a reset" model entirely, per product decision: staff
  // never change their own password, so there's nothing to invalidate it early.
  async setMemberPassword(params: { clientId: string; userId: string; customPassword?: string; requesterIsSuperAdmin: boolean }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin);
    if (params.customPassword && params.customPassword.length < 6) {
      throw Object.assign(new Error('Password must be at least 6 characters'), { statusCode: 400 });
    }

    const target = await prisma.user.findFirst({ where: { id: params.userId, clientId: params.clientId } });
    if (!target) throw Object.assign(new Error('Team member not found'), { statusCode: 404 });

    const finalPassword = params.customPassword || generateTempPassword();
    const [hashed, passwordEncrypted] = await Promise.all([
      AuthService.hashPassword(finalPassword),
      Promise.resolve(encryptCredential(finalPassword))
    ]);
    await prisma.user.update({ where: { id: params.userId }, data: { password: hashed, passwordEncrypted } });

    return { id: target.id, name: target.name, email: target.email, password: finalPassword };
  }
}

export const teamService = new TeamService();
