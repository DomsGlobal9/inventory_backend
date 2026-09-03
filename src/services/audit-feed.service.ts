import { prisma } from '../lib/prisma';

// Shared by the Platform Console (all clients) and a client's own Team & Users page
// (their own clientId only) -- both need the same merge of PlatformAdminSession
// (impersonation) + AuditLog (real mutations) into one standardized, sorted feed. A client
// seeing "a Scaleezy admin accessed your account" here is intentional transparency, not a
// leak -- it's scoped to sessions for THEIR clientId only.
export async function buildUnifiedAuditFeed(params: { clientId?: string; limit?: number }) {
  const limit = params.limit ?? 100;
  const sessionWhere = params.clientId ? { clientId: params.clientId } : {};
  const activityWhere = params.clientId ? { clientId: params.clientId } : {};

  const [sessions, activity] = await Promise.all([
    prisma.platformAdminSession.findMany({
      where: sessionWhere,
      take: limit,
      orderBy: { startedAt: 'desc' },
      include: { platformAdmin: { select: { name: true, email: true } } }
    }),
    prisma.auditLog.findMany({ where: activityWhere, take: limit, orderBy: { createdAt: 'desc' } })
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

  return [...sessionEvents, ...activityEvents]
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
