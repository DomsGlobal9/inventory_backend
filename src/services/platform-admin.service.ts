import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from './auth.service';
import { seedRolesForClient } from './rbac-seed.service';
import { seedCatalogDefaultsForClient } from './catalog-seed.service';
import { supportTicketService } from './support-ticket.service';
import { buildUnifiedAuditFeed } from './audit-feed.service';
import { encryptCredential, decryptCredential } from '../lib/credentialEncryption';

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

    const user = await prisma.user.create({
      data: { clientId, name: adminName, email: adminEmail, password: hashed, passwordEncrypted, status: 'ACTIVE' }
    });

    await prisma.userRole.create({
      data: { userId: user.id, roleId: roleIds.SUPER_ADMIN }
    });

    return { clientId, adminName, adminEmail, tempPassword };
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
