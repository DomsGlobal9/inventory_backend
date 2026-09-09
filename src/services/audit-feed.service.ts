import { prisma } from '../lib/prisma';

// Shared by the Platform Console (all clients) and a client's own Team & Users page (their own
// clientId only) -- both need the same merge of AuditLog (real mutations by real users) into
// one standardized, sorted feed.
//
// The one difference is PlatformAdminSession, the record of Scaleezy staff entering a client's
// workspace. The console sees those; a client's own Team & Users page does not.
//
// This used to be shown to clients as deliberate transparency, and that is a genuine argument.
// It is now off by product decision, so what changes is only who can SEE the row -- every
// session is still recorded, still visible in the platform console, and still auditable. This
// hides it from one screen; it does not stop it being written.
export async function buildUnifiedAuditFeed(params: {
  clientId?: string;
  limit?: number;
  /** Scaleezy staff entering a workspace. Console only -- never a client's own feed. */
  includeAdminSessions?: boolean;
}) {
  const limit = params.limit ?? 100;
  const sessionWhere = params.clientId ? { clientId: params.clientId } : {};
  const activityWhere = params.clientId ? { clientId: params.clientId } : {};

  // Defaults to true so the console, which passes nothing, keeps its full picture. A client
  // feed has to ask for the narrower view explicitly, which is the safer direction for a flag
  // to fail in: forgetting it shows too much to an operator, not the reverse.
  const includeAdminSessions = params.includeAdminSessions !== false;

  const [sessions, activity, adminActions] = await Promise.all([
    includeAdminSessions
      ? prisma.platformAdminSession.findMany({
          where: sessionWhere,
          take: limit,
          orderBy: { startedAt: 'desc' },
          include: { platformAdmin: { select: { name: true, email: true } } }
        })
      : Promise.resolve([]),
    prisma.auditLog.findMany({ where: activityWhere, take: limit, orderBy: { createdAt: 'desc' } }),
    // Everything a platform admin did that was not entering an account: reading a password,
    // suspending a shop, issuing a service key. Gated on the same flag as sessions, because it
    // is the same category of information -- what Scaleezy staff did -- and belongs on the
    // console rather than in a client's own activity feed.
    //
    // Filtered by targetId when a client feed asks, since a client's id is what these rows
    // carry as their target. A row about a USER is matched through targetLabel, which carries
    // the client id in brackets.
    includeAdminSessions
      ? prisma.platformAdminAction.findMany({
          where: params.clientId
            ? { OR: [{ targetId: params.clientId }, { targetLabel: { contains: params.clientId } }] }
            : {},
          take: limit,
          orderBy: { createdAt: 'desc' }
        })
      : Promise.resolve([])
  ]);

  const userIds = [...new Set(activity.map(a => a.userId).filter((id): id is string => !!id))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : [];
  const userMap = new Map(users.map(u => [u.id, u]));

  const sessionEvents = sessions.map(s => ({
    id: `session-${s.id}`,
    type: 'ADMIN_SESSION' as const,
    title: `${s.platformAdmin.name} (Scaleezy Support) accessed this account`,
    clientId: s.clientId,
    actorName: s.platformAdmin.name,
    timestamp: s.startedAt,
    endedAt: s.endedAt
  }));

  const activityEvents = activity.map(a => {
    const user = a.userId ? userMap.get(a.userId) : null;
    const actorName = user?.name || 'A user';
    // Keyed by "entityType:action", not action alone -- the audit-logger middleware infers
    // action purely from the URL's last path segment, so a generic code like STATUS or ROLE
    // is not unique to Team & Users; it's also what /purchase-orders/:id/status produces.
    // A global action->label map would silently mislabel unrelated events.
    const key = `${a.entityType}:${a.action}`;
    const override = ACTION_LABELS[key];
    const title = override
      ? `${actorName} ${override}`
      : `${actorName} ${a.action.replace(/_/g, ' ').toLowerCase()} ${a.entityType.replace(/_/g, ' ').toLowerCase()}`;
    return {
      id: `activity-${a.id}`,
      type: 'USER_ACTIVITY' as const,
      title,
      clientId: a.clientId,
      actorName,
      timestamp: a.createdAt,
      action: a.action,
      entityType: a.entityType
    };
  });

  const adminActionEvents = adminActions.map(a => ({
    id: `admin-action-${a.id}`,
    type: 'ADMIN_ACTION' as const,
    title: `${a.adminName} (Scaleezy) ${ADMIN_ACTION_LABELS[a.action] ?? a.action.replace(/_/g, ' ').toLowerCase()}${a.targetLabel ? ` -- ${a.targetLabel}` : ''}`,
    clientId: a.targetType === 'CLIENT' ? a.targetId ?? '' : '',
    actorName: a.adminName,
    timestamp: a.createdAt,
    action: a.action,
    entityType: a.targetType
  }));

  return [...sessionEvents, ...activityEvents, ...adminActionEvents]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

// "entityType:action" -> a complete, human phrase. Only for cases where the generic
// "{actor} {action} {entity}" fallback reads badly -- e.g. inferred action codes like
// MEMBERS/ROLE/STATUS from Team & Users routes, which are also produced by unrelated
// features (a purchase order's STATUS change looks identical at the action-code level).
const ACTION_LABELS: Record<string, string> = {
  'TEAM:MEMBERS': 'added a team member',
  'TEAM:ROLE': "changed a team member's role",
  'TEAM:STATUS': "changed a team member's status",
  'TEAM:PASSWORD': "set a team member's password",
  'TEAM:VIEW': "viewed a team member's password",
  'USER:CHANGED_PASSWORD': 'changed their password',
};

/**
 * What each console action reads as in the log.
 *
 * Written as plain statements of what happened, not softened. Someone scanning this list is
 * usually scanning it because they are worried, and "viewed a shop owner's password in plain
 * text" is the sentence that answers them -- "VIEW_PASSWORD" is not.
 */
const ADMIN_ACTION_LABELS: Record<string, string> = {
  VIEW_PASSWORD: "viewed a user's password in plain text",
  RESET_USER_PASSWORD: "set a new password for a user",
  ONBOARD_CLIENT: 'created a new client',
  SUSPEND_CLIENT: "changed a client's suspension",
  DELETE_CLIENT: 'permanently deleted a client',
  SET_SERVICE_KEY: 'issued a service key',
  REVOKE_SERVICE_KEY: 'revoked a service key',
  SET_TRYON_LIMIT: 'changed a try-on limit',
  ASSUME_CLIENT: "entered a client's account",
  END_ASSUMED_SESSION: 'left an assumed account',
  CREATE_PLATFORM_ADMIN: 'created another platform admin',
  SET_PLATFORM_ADMIN_STATUS: "changed a platform admin's status",
  RESET_PLATFORM_ADMIN_PASSWORD: "reset a platform admin's password",
  REPLY_SUPPORT_TICKET: 'replied to a support ticket',
  UPDATE_SUPPORT_TICKET: 'changed a support ticket',
  UPDATE_LEAD: 'updated a lead',
  CONVERT_LEAD: 'converted a lead into a client'
};
