import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from './auth.service';
import { forgetIdentity } from '../lib/identityCache';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';
import { buildUnifiedAuditFeed } from './audit-feed.service';
import { mailService } from './mail.service';
import { normalisePhone } from '../lib/phone';
import { getShopSettings } from '../lib/clientSettings';
import { env } from '../config/env';
import { expandPermissions, getPermission, WILDCARD_PERMISSION } from '../config/permissions';

/**
 * What a key-set holds that the requester does not.
 *
 * The team screen used to protect only the role NAMED Super Admin. A manager allowed to manage the
 * team could therefore invite an account into any other role -- one the owner built with cost,
 * password viewing or everything but the '*' -- set its password, and sign in as it; or reset the
 * password of a co-owner holding everything bar '*' and read it back. The roles screen already
 * refused to let anyone grant what they lack. This is the same rule, applied to who may be given
 * a role and whose account may be managed.
 */
function beyond(requesterPermissions: readonly string[], keys: readonly string[]): string[] {
  if (keys.includes(WILDCARD_PERMISSION)) return [WILDCARD_PERMISSION];
  const have = expandPermissions(requesterPermissions);
  return [...expandPermissions(keys)].filter(k => k !== WILDCARD_PERMISSION && !have.has(k));
}

const describe = (keys: string[]) =>
  keys.map(k => (k === WILDCARD_PERMISSION ? 'total access' : getPermission(k)?.label ?? k)).join('; ');

async function roleKeys(roleId: string): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({ where: { roleId }, select: { permission: { select: { key: true } } } });
  return rows.map(r => r.permission.key);
}

async function userKeys(clientId: string, userId: string): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { role: { clientId, users: { some: { userId } } } },
    select: { permission: { select: { key: true } } }
  });
  return rows.map(r => r.permission.key);
}

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe -- same scheme as onboarding
}

export class TeamService {
  async listMembers(clientId: string) {
    return prisma.user.findMany({
      where: { clientId },
      select: {
        id: true, name: true, email: true, phone: true, status: true, lastActiveAt: true, lastLoginAt: true, createdAt: true,
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
  private async assertCanManageTarget(clientId: string, targetUserId: string, requesterIsSuperAdmin: boolean, requesterPermissions?: string[]) {
    if (requesterIsSuperAdmin) return;
    if (requesterPermissions) {
      const more = beyond(requesterPermissions, await userKeys(clientId, targetUserId));
      if (more.length) {
        throw Object.assign(new Error(`You cannot manage this account: it can do things you cannot (${describe(more)}).`), { statusCode: 403 });
      }
    }
    const target = await prisma.user.findFirst({
      where: { id: targetUserId, clientId },
      include: { roles: { include: { role: true } } }
    });
    if (target?.roles.some(ur => ur.role.name === 'SUPER_ADMIN')) {
      throw Object.assign(new Error('Only a Super Admin can manage another Super Admin\'s account'), { statusCode: 403 });
    }
  }

  async inviteMember(params: {
    clientId: string; name: string; email: string; roleId: string; customPassword?: string; phone?: unknown; requesterIsSuperAdmin: boolean; requesterPermissions?: string[];
  }) {
    const phone = memberPhone(params.phone);
    const role = await prisma.role.findUnique({ where: { id: params.roleId } });
    if (!role || role.clientId !== params.clientId) {
      throw Object.assign(new Error('Role not found'), { statusCode: 404 });
    }
    if (role.name === 'SUPER_ADMIN' && !params.requesterIsSuperAdmin) {
      throw Object.assign(new Error('Only a Super Admin can grant the Super Admin role'), { statusCode: 403 });
    }
    if (!params.requesterIsSuperAdmin && params.requesterPermissions) {
      const more = beyond(params.requesterPermissions, await roleKeys(role.id));
      if (more.length) {
        throw Object.assign(new Error(`You cannot give someone more access than you have yourself: ${describe(more)}.`), { statusCode: 403 });
      }
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
      data: { clientId: params.clientId, name: params.name, email: params.email, password: hashed, passwordEncrypted, status: 'ACTIVE', ...(phone ? { phone } : {}) }
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

    // Awaited, unlike the storefront notifications elsewhere, and for the opposite reason: the
    // admin is standing at this screen deciding whether they still need to send the password
    // by hand. Telling them a second later that it was emailed is useful; telling them nothing
    // and hoping means they either double-send or assume it worked when it did not.
    //
    // It cannot fail the creation -- sendCredentials never throws, it reports.
    const shop = await prisma.clientSettings.findUnique({ where: { clientId: params.clientId }, select: { businessName: true } }).catch(() => null);
    const delivery = await mailService.sendCredentials({
      recipientName: user.name, email: user.email, password: finalPassword, roleLabel: role.name,
      shopName: shop?.businessName ?? null
    });

    return {
      id: user.id, name: user.name, email: user.email, phone: user.phone, role: role.name, password: finalPassword,
      emailed: delivery.sent, emailReason: delivery.reason
    };
  }

  async updateMemberRole(params: { clientId: string; userId: string; roleId: string; requesterIsSuperAdmin: boolean; requesterPermissions?: string[] }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin, params.requesterPermissions);

    const role = await prisma.role.findUnique({ where: { id: params.roleId } });
    if (!role || role.clientId !== params.clientId) {
      throw Object.assign(new Error('Role not found'), { statusCode: 404 });
    }
    if (role.name === 'SUPER_ADMIN' && !params.requesterIsSuperAdmin) {
      throw Object.assign(new Error('Only a Super Admin can grant the Super Admin role'), { statusCode: 403 });
    }
    if (!params.requesterIsSuperAdmin && params.requesterPermissions) {
      const more = beyond(params.requesterPermissions, await roleKeys(role.id));
      if (more.length) {
        throw Object.assign(new Error(`You cannot give someone more access than you have yourself: ${describe(more)}.`), { statusCode: 403 });
      }
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
    // Their permissions just changed, and the middleware holds the old set briefly unless
    // told. A demotion that takes effect half a minute later is a real hole.
    forgetIdentity(params.userId);

    return { id: target.id, role: role.name };
  }

  async setMemberStatus(params: { clientId: string; userId: string; status: 'ACTIVE' | 'INACTIVE'; requesterUserId: string; requesterIsSuperAdmin: boolean; requesterPermissions?: string[] }) {
    if (params.userId === params.requesterUserId) {
      throw Object.assign(new Error('You cannot deactivate your own account'), { statusCode: 400 });
    }
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin, params.requesterPermissions);

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

    // Switched off, their sign-ins end for good: switching them back on later must not revive a token
    // somebody copied in the meantime.
    const updated = await prisma.user.update({
      where: { id: params.userId },
      data: { status: params.status, ...(params.status !== 'ACTIVE' ? { sessionVersion: { increment: 1 } } : {}) }
    });
    // Deactivating someone has to take effect on their very next request, not when a cache
    // entry happens to expire.
    forgetIdentity(params.userId);
    return updated;
  }

  // Decrypts and returns the team member's CURRENT password, so an admin can re-share it on
  // request without generating a new one. Deliberately explicit and on-demand (never
  // returned as part of listMembers) -- viewing a password is a meaningful action worth its
  // own audit trail entry, not a side effect of loading a list.
  async viewMemberPassword(params: { clientId: string; userId: string; requesterIsSuperAdmin: boolean; requesterPermissions?: string[] }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin, params.requesterPermissions);

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
  async resendCredentials(params: { clientId: string; userId: string; requesterIsSuperAdmin: boolean; requesterPermissions?: string[] }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin, params.requesterPermissions);

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
      roleLabel: target.roles[0]?.role.name,
      shopName: (await prisma.clientSettings.findUnique({ where: { clientId: params.clientId }, select: { businessName: true } }).catch(() => null))?.businessName ?? null
    });

    if (!delivery.sent) {
      throw Object.assign(new Error(delivery.reason ?? 'The message could not be sent.'), { statusCode: 502 });
    }

    return { id: target.id, email: target.email, sent: true };
  }

  /**
   * Sends a team member their login on WhatsApp, FROM THE SHOP'S OWN NUMBER, to their mobile.
   *
   * The same disclosure as emailing it (resendCredentials), so the same guard: an Admin cannot do
   * this to a Super Admin's account. A number typed here is saved on the person for next time.
   * `nonce` is one press of the button: pressing twice by accident sends once.
   */
  async sendCredentialsWhatsApp(params: { clientId: string; userId: string; phone?: unknown; nonce?: unknown; sentBy: string; requesterIsSuperAdmin: boolean; requesterPermissions?: string[] }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin, params.requesterPermissions);
    const target = await prisma.user.findFirst({
      where: { id: params.userId, clientId: params.clientId },
      include: { roles: { include: { role: true } } }
    });
    if (!target) throw Object.assign(new Error('Team member not found'), { statusCode: 404 });
    if (!target.passwordEncrypted) {
      throw Object.assign(new Error('No password on file to send for this account -- set a new one instead'), { statusCode: 404 });
    }
    const typed = params.phone === undefined || params.phone === null || params.phone === '' ? null : memberPhone(params.phone);
    const phone = typed ?? target.phone;
    if (!phone) throw Object.assign(new Error(`Add ${target.name}'s mobile number to send their login on WhatsApp.`), { statusCode: 400 });
    if (typed && typed !== target.phone) {
      await prisma.user.update({ where: { id: target.id }, data: { phone: typed } });
      forgetIdentity(target.id);
    }

    // Imported here: the WhatsApp module reaches back into customers and campaigns.
    const { sendShopText, shopNumber } = await import('./whatsapp/service');
    const account = await shopNumber(params.clientId).catch(() => null);
    if (!account || account.status !== 'CONNECTED') {
      throw Object.assign(new Error("Your shop's WhatsApp is not connected, so nothing was sent. Connect it in Settings → WhatsApp, or use Copy."), { statusCode: 409 });
    }
    const { businessName } = await getShopSettings(params.clientId);
    const role = target.roles[0]?.role.name;
    const text = [
      `Hello ${target.name},`,
      '',
      `You have been added to ${businessName || 'our shop'} on ScaleEzy Inventory${role ? ` as ${role}` : ''}.`,
      '',
      `Email: ${target.email}`,
      `Password: ${decryptCredential(target.passwordEncrypted)}`,
      '',
      `Sign in: ${env.FRONTEND_URL.replace(/\/$/, '')}/login`,
      '',
      'Please keep this password to yourself.'
    ].join('\n');
    const nonce = typeof params.nonce === 'string' && params.nonce ? params.nonce.slice(0, 64) : String(Date.now());
    await sendShopText({
      clientId: params.clientId, to: phone, text, kind: 'TEAM_LOGIN', referenceId: target.id,
      idempotencyKey: `TEAM_LOGIN:${target.id}:${nonce}`, sentBy: params.sentBy
    });
    return { id: target.id, sent: true, to: phone };
  }

  // Sets a permanent password (auto-generated or admin-chosen) -- replaces the old
  // "temporary password that forces a reset" model entirely, per product decision: staff
  // never change their own password, so there's nothing to invalidate it early.
  async setMemberPassword(params: { clientId: string; userId: string; customPassword?: string; requesterIsSuperAdmin: boolean; requesterPermissions?: string[] }) {
    await this.assertCanManageTarget(params.clientId, params.userId, params.requesterIsSuperAdmin, params.requesterPermissions);
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
    // Both copies (sign-in hash and the viewable one), and every existing sign-in of theirs ends.
    await prisma.user.update({ where: { id: params.userId }, data: { password: hashed, passwordEncrypted, sessionVersion: { increment: 1 } } });
    forgetIdentity(params.userId);

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

/** A team member's mobile, stored the one way the app stores numbers; refused in words. */
function memberPhone(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const r = normalisePhone(raw);
  if (!r.ok) throw Object.assign(new Error(r.reason.replace("the customer's", 'their')), { statusCode: 400 });
  return r.value;
}
