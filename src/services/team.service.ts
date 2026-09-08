import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from './auth.service';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';
import { buildUnifiedAuditFeed } from './audit-feed.service';
import { mailService } from './mail.service';

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
    // Without the flag this feed also carried "<name> (Scaleezy Support) accessed this
    // account". Those rows are still written and still visible in the platform console --
    // they are simply not shown on the shop's own screen.
    return buildUnifiedAuditFeed({ clientId, limit: 30, includeAdminSessions: false });
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

    // Awaited, unlike the storefront notifications elsewhere, and for the opposite reason: the
    // admin is standing at this screen deciding whether they still need to send the password
    // by hand. Telling them a second later that it was emailed is useful; telling them nothing
    // and hoping means they either double-send or assume it worked when it did not.
    //
    // It cannot fail the creation -- sendCredentials never throws, it reports.
    const delivery = await mailService.sendCredentials({
      recipientName: user.name, email: user.email, password: finalPassword, roleLabel: role.name
    });

    return {
      id: user.id, name: user.name, email: user.email, role: role.name, password: finalPassword,
      emailed: delivery.sent, emailReason: delivery.reason
    };
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

  /**
   * Emails a team member their existing login again.
   *
   * The everyday case this exists for: the first message went to spam, or was deleted, or the
   * person says they never got it. Without this the admin's only options are to read the
   * password off the screen and paste it somewhere by hand, or to CHANGE the password -- which
   * breaks the login for anyone already using it, to solve a delivery problem.
   *
   * Same guard as viewing a password, because it is the same disclosure: an Admin cannot do
   * this to a Super Admin's account.
   */
  async resendCredentials(params: { clientId: string; userId: string; requesterIsSuperAdmin: boolean }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin);

    const target = await prisma.user.findFirst({
      where: { id: params.userId, clientId: params.clientId },
      include: { roles: { include: { role: true } } }
    });
    if (!target) throw Object.assign(new Error('Team member not found'), { statusCode: 404 });
    if (!target.passwordEncrypted) {
      throw Object.assign(
        new Error('No password on file to resend for this account -- set a new one instead'),
        { statusCode: 404 }
      );
    }
    if (!mailService.isConfigured()) {
      // A specific 503 rather than a generic failure: the admin can see this is a setup
      // problem on the deployment, not something wrong with the account in front of them.
      throw Object.assign(
        new Error('Email is not set up on this deployment, so nothing can be resent. Use the WhatsApp or copy options.'),
        { statusCode: 503 }
      );
    }

    const delivery = await mailService.sendCredentials({
      recipientName: target.name,
      email: target.email,
      password: decryptCredential(target.passwordEncrypted),
      roleLabel: target.roles[0]?.role.name
    });

    if (!delivery.sent) {
      throw Object.assign(new Error(delivery.reason ?? 'The message could not be sent.'), { statusCode: 502 });
    }

    return { id: target.id, email: target.email, sent: true };
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

    // The password just changed, so the holder cannot sign in until they are told the new one.
    // Same contract as above: reported, never fatal.
    const delivery = await mailService.sendCredentials({
      recipientName: target.name, email: target.email, password: finalPassword
    });

    return {
      id: target.id, name: target.name, email: target.email, password: finalPassword,
      emailed: delivery.sent, emailReason: delivery.reason
    };
  }
}

export const teamService = new TeamService();
