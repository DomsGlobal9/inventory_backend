import { prisma } from '../lib/prisma';

/**
 * What a platform admin did, kept where deleting things cannot reach it.
 *
 * Before this, entering a client's account was the only console action that recorded anything
 * -- PlatformAdminSession. Everything else happened invisibly: reading a shop owner's password
 * in plain text, resetting it, suspending a shop, deleting one outright, issuing or revoking a
 * service key, changing a billing limit, creating another platform admin.
 *
 * The plaintext-password path is a deliberate feature. A client whose only Super Admin forgets
 * their password has no other route back in, and the alternative -- locking a paying shop out
 * of its own inventory -- is worse. But what makes a capability like that acceptable is not
 * that it is rarely used, it is that using it is recorded and someone can go and look.
 *
 * Kept as its own module rather than folded into platform-admin.service so that the thing
 * being watched and the thing doing the watching are not the same file.
 */

/** The console actions worth a row, and what they read as to a person. */
export type PlatformAuditAction =
  | 'VIEW_PASSWORD'
  | 'RESET_USER_PASSWORD'
  | 'ONBOARD_CLIENT'
  | 'SUSPEND_CLIENT'
  | 'DELETE_CLIENT'
  | 'SET_SERVICE_KEY'
  | 'REVOKE_SERVICE_KEY'
  | 'SET_TRYON_LIMIT'
  | 'ASSUME_CLIENT'
  | 'END_ASSUMED_SESSION'
  | 'CREATE_PLATFORM_ADMIN'
  | 'SET_PLATFORM_ADMIN_STATUS'
  | 'RESET_PLATFORM_ADMIN_PASSWORD'
  | 'REPLY_SUPPORT_TICKET'
  | 'UPDATE_SUPPORT_TICKET'
  | 'UPDATE_LEAD'
  | 'CONVERT_LEAD';

export type PlatformAuditTarget = 'CLIENT' | 'USER' | 'PLATFORM_ADMIN' | 'LEAD' | 'SUPPORT_TICKET' | 'SESSION';

export class PlatformAuditService {
  /**
   * Records one action. Never throws.
   *
   * A trail that can fail the request it is recording turns an audit problem into an outage,
   * and the pressure that follows is to remove the trail. So a write that cannot happen is
   * logged to the server console and the console keeps working -- the tradeoff is deliberate
   * and the console log is where a gap would be noticed.
   */
  async record(input: {
    platformAdminId: string;
    adminEmail: string;
    adminName: string;
    action: PlatformAuditAction | string;
    targetType: PlatformAuditTarget | string;
    targetId?: string | null;
    targetLabel?: string | null;
    ipAddress?: string | null;
  }): Promise<void> {
    try {
      await prisma.platformAdminAction.create({
        data: {
          platformAdminId: input.platformAdminId,
          adminEmail: input.adminEmail,
          adminName: input.adminName,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          targetLabel: input.targetLabel ?? null,
          ipAddress: input.ipAddress ?? null
        }
      });
    } catch (err) {
      console.error('[platform-audit] failed to record', input.action, input.targetId, err);
    }
  }

  /** The newest actions, for the console's Audit Log. */
  async list(limit = 100) {
    return prisma.platformAdminAction.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Every time anyone read this user's password.
   *
   * The question a shop owner is entitled to ask, and the reason the trail exists.
   */
  async passwordViewsFor(userId: string) {
    return prisma.platformAdminAction.findMany({
      where: { action: 'VIEW_PASSWORD', targetId: userId },
      orderBy: { createdAt: 'desc' }
    });
  }
}

export const platformAuditService = new PlatformAuditService();
