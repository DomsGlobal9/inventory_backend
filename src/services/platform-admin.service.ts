import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from './auth.service';
import { seedRolesForClient } from './rbac-seed.service';
import { seedCatalogDefaultsForClient } from './catalog-seed.service';
import { supportTicketService } from './support-ticket.service';
import { buildUnifiedAuditFeed } from './audit-feed.service';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';
import { mailService } from './mail.service';

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe -- same scheme as team.service.ts
}

export class PlatformAdminService {
  // There is no local `Client` registry (see SUPER_ADMIN_PLAN.md) -- every clientId this
  // console can ever show is derived from the `User` table, so a client with zero users
  // is invisible here. That's a known, documented limitation, not a bug.
  // Aggregated across ALL tenants in a fixed number of queries.
  //
  // This used to be `Promise.all(clientIds.map(id => this.getClientSummary(id)))`, and
  // getClientSummary itself fires 7 queries in its own Promise.all -- so the console's
  // front page issued 7 x (tenant count) queries simultaneously. At 16 tenants that is 112
  // concurrent queries against a Prisma pool of ~17 over a pgbouncer pooler: measured at
  // 6.8s for a single load, and 4 of 6 concurrent loads failing outright with pool-timeout
  // 500s. It degraded linearly with every client onboarded -- i.e. it got worse precisely
  // as the product succeeded. Now it is 6 grouped queries regardless of tenant count.
  async listClients() {
    const [tenants, userStats, productCounts, activeProductCounts, alertCounts, valueSums, superAdmins] =
      await Promise.all([
        prisma.user.findMany({ distinct: ['clientId'], select: { clientId: true } }),
        prisma.user.groupBy({
          by: ['clientId'],
          _count: { _all: true },
          _max: { lastLoginAt: true, lastActiveAt: true }
        }),
        prisma.product.groupBy({
          by: ['clientId'],
          where: { status: { notIn: ['TRASHED'] as any } },
          _count: { _all: true }
        }),
        prisma.product.groupBy({
          by: ['clientId'],
          where: { status: 'ACTIVE' as any },
          _count: { _all: true }
        }),
        prisma.inventoryAlert.groupBy({
          by: ['clientId'],
          where: { isResolved: false },
          _count: { _all: true }
        }),
        prisma.productVariant.groupBy({
          by: ['clientId'],
          _sum: { inventoryValue: true }
        }),
        // Earliest SUPER_ADMIN per client -- ordered ascending so the first row seen for a
        // clientId is the one getClientSummary would have picked.
        prisma.user.findMany({
          where: { roles: { some: { role: { name: 'SUPER_ADMIN' } } } },
          select: { clientId: true, name: true, email: true },
          orderBy: { createdAt: 'asc' }
        })
      ]);

    const byClient = <T extends { clientId: string }>(rows: T[]) =>
      new Map(rows.map(r => [r.clientId, r]));

    const users = byClient(userStats);
    const products = byClient(productCounts);
    const activeProducts = byClient(activeProductCounts);
    const alerts = byClient(alertCounts);
    const values = byClient(valueSums);

    const admins = new Map<string, { name: string | null; email: string | null }>();
    for (const a of superAdmins) if (!admins.has(a.clientId)) admins.set(a.clientId, a);

    return tenants.map(({ clientId }) => {
      const productCount = products.get(clientId)?._count._all ?? 0;
      const activeProductCount = activeProducts.get(clientId)?._count._all ?? 0;
      const admin = admins.get(clientId);

      return {
        clientId,
        userCount: users.get(clientId)?._count._all ?? 0,
        lastLoginAt: users.get(clientId)?._max.lastLoginAt ?? null,
        lastActiveAt: users.get(clientId)?._max.lastActiveAt ?? null,
        productCount,
        activeProductCount,
        activeAlertCount: alerts.get(clientId)?._count._all ?? 0,
        inventoryValue: Number(values.get(clientId)?._sum.inventoryValue || 0),
        // Same heuristic as getClientSummary -- kept identical so the list and the
        // single-client overview can never disagree about a client's status.
        onboardingStatus:
          productCount === 0 ? 'NOT_STARTED' : activeProductCount === 0 ? 'IN_PROGRESS' : 'ACTIVE',
        adminName: admin?.name || null,
        adminEmail: admin?.email || null
      };
    });
  }

  async getClientSummary(clientId: string) {
    const [userCount, activityAgg, productCount, activeProductCount, alertCount, inventoryValueAgg, adminUser] = await Promise.all([
      prisma.user.count({ where: { clientId } }),
      prisma.user.aggregate({ where: { clientId }, _max: { lastLoginAt: true, lastActiveAt: true } }),
      prisma.product.count({ where: { clientId, status: { notIn: ['TRASHED'] } } }),
      prisma.product.count({ where: { clientId, status: 'ACTIVE' } }),
      prisma.inventoryAlert.count({ where: { clientId, isResolved: false } }),
      prisma.productVariant.aggregate({ where: { clientId }, _sum: { inventoryValue: true } }),
      prisma.user.findFirst({
        where: { clientId, roles: { some: { role: { name: 'SUPER_ADMIN' } } } },
        select: { name: true, email: true },
        orderBy: { createdAt: 'asc' }
      })
    ]);

    // Onboarding is a heuristic, not a stored concept -- there's no onboarding-flow
    // model anywhere in this schema. "Has ever created a product" is the simplest
    // honest signal available locally.
    const onboardingStatus = productCount === 0 ? 'NOT_STARTED' : activeProductCount === 0 ? 'IN_PROGRESS' : 'ACTIVE';

    return {
      clientId,
      userCount,
      lastLoginAt: activityAgg._max.lastLoginAt,
      // What actually happened most recently in this client's inventory, not just when
      // someone last typed a password -- backed by lastActiveAt (bumped on every
      // authenticated business request, see activity-tracker.middleware.ts).
      lastActiveAt: activityAgg._max.lastActiveAt,
      productCount,
      activeProductCount,
      activeAlertCount: alertCount,
      inventoryValue: Number(inventoryValueAgg._sum.inventoryValue || 0),
      onboardingStatus,
      adminName: adminUser?.name || null,
      adminEmail: adminUser?.email || null
    };
  }

  async listAllUsers() {
    return prisma.user.findMany({
      select: {
        id: true,
        clientId: true,
        name: true,
        email: true,
        status: true,
        lastLoginAt: true,
        lastActiveAt: true,
        createdAt: true,
        roles: { select: { role: { select: { name: true } } } }
      },
      // Postgres sorts NULL as the largest value by default, so a plain `desc` here puts
      // every user who has never been active ahead of everyone with real recent activity --
      // the opposite of "most recently active first". `nulls: 'last'` fixes that.
      orderBy: { lastActiveAt: { sort: 'desc', nulls: 'last' } }
    });
  }

  async getClientUsers(clientId: string) {
    return prisma.user.findMany({
      where: { clientId },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        lastLoginAt: true,
        lastActiveAt: true,
        createdAt: true,
        roles: { select: { role: { select: { name: true } } } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async assumeClient(platformAdminId: string, clientId: string) {
    const userCount = await prisma.user.count({ where: { clientId } });
    if (userCount === 0) {
      throw new Error('Unknown client -- no users found for this clientId');
    }

    // Assuming a new client implicitly ends the previous impersonation; the UI keeps
    // only one sessionId in localStorage, so the old one would otherwise be unreachable.
    await this.endOpenSessionsForAdmin(platformAdminId);

    const session = await prisma.platformAdminSession.create({
      data: { platformAdminId, clientId }
    });

    return session;
  }

  // Closes any impersonation row still marked open for this admin. endAssumedSession
  // only ever fired from the "Exit to Console" button, so assuming a second client,
  // signing out, or just closing the tab left the previous row with endedAt = null --
  // badged ACTIVE forever in the Audit Log, and shown to the client's own team as
  // "a Scaleezy admin is currently inside your account".
  async endOpenSessionsForAdmin(platformAdminId: string) {
    return prisma.platformAdminSession.updateMany({
      where: { platformAdminId, endedAt: null },
      data: { endedAt: new Date() }
    });
  }

  async endAssumedSession(sessionId: string) {
    return prisma.platformAdminSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date() }
    });
  }

  // Turns "Acme Boutique Pvt Ltd" into "acme-boutique-pvt-ltd", then disambiguates
  // against every clientId already known locally (derived from Users, same as
  // listClients -- there's no separate Client registry to check against).
  private async generateClientId(companyName: string) {
    const base = companyName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'client';

    const existing = new Set(
      (await prisma.user.findMany({ distinct: ['clientId'], select: { clientId: true } })).map(u => u.clientId)
    );

    if (!existing.has(base)) return base;

    let suffix = 2;
    while (existing.has(`${base}-${suffix}`)) suffix++;
    return `${base}-${suffix}`;
  }

  async onboardClient(companyName: string, adminName: string, adminEmail: string) {
    const clientId = await this.generateClientId(companyName);

    const tempPassword = crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe
    const hashed = await AuthService.hashPassword(tempPassword);
    // Same reversible-encryption scheme as Team & Users (team.service.ts) -- this account
    // is itself a team member of the new client, so its password should be viewable there
    // too, not just at the moment of onboarding.
    const passwordEncrypted = encryptCredential(tempPassword);

    const roleIds = await seedRolesForClient(clientId);
    await seedCatalogDefaultsForClient(clientId);

    // Every stock movement requires a locationId, and a freshly onboarded client had NO
    // locations at all -- so their very first product silently lost its opening stock:
    // variant.service's resolveInitialStockLocationIds returned [], applyInitialStock
    // looped over nothing, and the UI still reported "Product created successfully" while
    // the quantity went nowhere. That resolver already looks for exactly this code, so the
    // MAIN-STORE location was always the intended default -- onboarding just never made it.
    // Created here so a new workspace is usable the moment the client logs in; they can
    // rename it or add more under Settings -> Stock Locations.
    await prisma.stockLocation.create({
      data: { clientId, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true }
    });

    const user = await prisma.user.create({
      data: { clientId, name: adminName, email: adminEmail, password: hashed, passwordEncrypted, status: 'ACTIVE' }
    });

    await prisma.userRole.create({
      data: { userId: user.id, roleId: roleIds.SUPER_ADMIN }
    });

    // The shop owner's login is the last thing standing between onboarding and them actually
    // using the product, and until now it left this building by being read off a console
    // screen and typed into a message by hand.
    const delivery = await mailService.sendCredentials({
      recipientName: adminName, email: adminEmail, password: tempPassword, roleLabel: 'SUPER_ADMIN'
    });

    return { clientId, adminName, adminEmail, tempPassword, emailed: delivery.sent, emailReason: delivery.reason };
  }

  // ─── PLATFORM ADMINS ────────────────────────────────────────────────────────
  //
  // Whoever is in this table can read and act on EVERY tenant's data. There is no hierarchy
  // among them -- any platform admin can add another -- so the guards here are about not
  // locking everyone out, and about not leaving a permanent decryptable copy of a key that
  // opens every shop.

  async listPlatformAdmins() {
    return prisma.platformAdmin.findMany({
      // No password field, encrypted or otherwise. Nothing here should ever be able to return
      // one, so it is excluded at the query rather than trusted to be dropped later.
      select: { id: true, name: true, email: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' }
    });
  }

  /**
   * Adds a platform admin.
   *
   * The password is generated, shown once, and emailed. Unlike a shop user it is stored ONLY
   * as a bcrypt hash -- there is deliberately no reversible copy, so this password cannot be
   * viewed or re-sent later. A shop assistant's password protects one shop; this one opens
   * every tenant on the platform, and a decryptable copy of it sitting in a table is a far
   * larger prize. If the message is lost, issue a new password rather than recovering the old.
   */
  async createPlatformAdmin(params: { name: string; email: string; customPassword?: string }) {
    const email = params.email.trim().toLowerCase();

    if (params.customPassword && params.customPassword.length < 12) {
      throw Object.assign(
        new Error('A platform admin password must be at least 12 characters -- this account can see every tenant'),
        { statusCode: 400 }
      );
    }

    const existing = await prisma.platformAdmin.findUnique({ where: { email } });
    if (existing) {
      throw Object.assign(new Error('A platform admin with this email already exists'), { statusCode: 409 });
    }

    // Longer than the shop-staff default for the same reason as the check above.
    const password = params.customPassword || crypto.randomBytes(15).toString('base64url');
    const hashed = await AuthService.hashPassword(password);

    const admin = await prisma.platformAdmin.create({
      data: { name: params.name.trim(), email, password: hashed, status: 'ACTIVE' },
      select: { id: true, name: true, email: true, status: true, createdAt: true }
    });

    const delivery = await mailService.sendCredentials({
      recipientName: admin.name, email: admin.email, password, roleLabel: 'Platform Admin'
    });

    // Returned once. There is no second chance to read it -- see the note above.
    return { ...admin, password, emailed: delivery.sent, emailReason: delivery.reason };
  }

  /**
   * Activates or deactivates a platform admin.
   *
   * Refuses to deactivate the last active one. Without that check a single click locks
   * everybody out of the console permanently, and the only way back in is a database edit.
   */
  async setPlatformAdminStatus(params: { adminId: string; status: 'ACTIVE' | 'INACTIVE'; requesterId: string }) {
    if (params.adminId === params.requesterId && params.status !== 'ACTIVE') {
      throw Object.assign(new Error('You cannot deactivate your own account'), { statusCode: 400 });
    }

    const target = await prisma.platformAdmin.findUnique({ where: { id: params.adminId } });
    if (!target) throw Object.assign(new Error('Platform admin not found'), { statusCode: 404 });

    if (params.status !== 'ACTIVE') {
      const remaining = await prisma.platformAdmin.count({
        where: { status: 'ACTIVE', id: { not: params.adminId } }
      });
      if (remaining === 0) {
        throw Object.assign(
          new Error('This is the only active platform admin -- add another before deactivating this one'),
          { statusCode: 409 }
        );
      }
    }

    return prisma.platformAdmin.update({
      where: { id: params.adminId },
      data: { status: params.status },
      select: { id: true, name: true, email: true, status: true }
    });
  }

  /**
   * Issues a new password for a platform admin and emails it.
   *
   * This is what replaces "resend" for these accounts. The old password cannot be recovered,
   * so the honest operation is to replace it -- and the person is told, because their existing
   * password stops working the moment this runs.
   */
  async resetPlatformAdminPassword(params: { adminId: string; customPassword?: string }) {
    if (params.customPassword && params.customPassword.length < 12) {
      throw Object.assign(new Error('A platform admin password must be at least 12 characters'), { statusCode: 400 });
    }

    const target = await prisma.platformAdmin.findUnique({ where: { id: params.adminId } });
    if (!target) throw Object.assign(new Error('Platform admin not found'), { statusCode: 404 });

    const password = params.customPassword || crypto.randomBytes(15).toString('base64url');
    await prisma.platformAdmin.update({
      where: { id: params.adminId },
      data: { password: await AuthService.hashPassword(password) }
    });

    const delivery = await mailService.sendCredentials({
      recipientName: target.name, email: target.email, password, roleLabel: 'Platform Admin'
    });

    return {
      id: target.id, name: target.name, email: target.email, password,
      emailed: delivery.sent, emailReason: delivery.reason
    };
  }

  // Merges two independent event sources -- PlatformAdminSession (a super admin viewing a
  // client) and AuditLog (a real user's mutation inside their own tenant) -- into one
  // standardized, chronologically sorted feed. Each source keeps its own table and pruning
  // rules; this is purely a read-time projection.
  async listAuditLog(limit = 100) {
    return buildUnifiedAuditFeed({ limit });
  }

  async listClientErrors(limit = 100) {
    return prisma.clientErrorLog.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' }
    });
  }

  async listAllSupportTickets() {
    return supportTicketService.listAllTickets();
  }

  async getSupportTicket(ticketId: string) {
    return supportTicketService.getTicket(ticketId);
  }

  async replyToSupportTicket(ticketId: string, adminName: string, body: string) {
    return supportTicketService.addMessage(ticketId, { authorType: 'PLATFORM_ADMIN', authorName: adminName, body });
  }

  async updateSupportTicketStatus(ticketId: string, status: string) {
    return supportTicketService.updateStatus(ticketId, status);
  }

  // The recovery path of last resort: a client's Team & Users deliberately blocks managing
  // your OWN row (see team.service.ts), so a client with exactly one Super Admin -- the
  // common case right after onboarding -- has no in-app way to recover if that person
  // forgets their password. A platform admin outranks every client role, so no hierarchy
  // guard applies here.
  async viewUserPassword(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    if (!user.passwordEncrypted) {
      throw Object.assign(new Error('No viewable password on file for this account -- set a new one instead'), { statusCode: 404 });
    }
    return { id: user.id, name: user.name, email: user.email, password: decryptCredential(user.passwordEncrypted) };
  }

  async setUserPassword(userId: string, customPassword?: string) {
    if (customPassword && customPassword.length < 6) {
      throw Object.assign(new Error('Password must be at least 6 characters'), { statusCode: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

    const finalPassword = customPassword || generateTempPassword();
    const [hashed, passwordEncrypted] = await Promise.all([
      AuthService.hashPassword(finalPassword),
      Promise.resolve(encryptCredential(finalPassword))
    ]);
    await prisma.user.update({ where: { id: userId }, data: { password: hashed, passwordEncrypted } });

    return { id: user.id, name: user.name, email: user.email, password: finalPassword };
  }
}

export const platformAdminService = new PlatformAdminService();
