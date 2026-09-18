/**
 * Security log: who signed in, who read or set a password, who changed a role or the team.
 *
 * These rows live in audit_logs beside ordinary activity, but they are kept differently. The
 * activity feed keeps only a shop's last few dozen rows, because "what has my team been doing
 * lately" needs no more -- and until this module existed that same trim deleted the record of
 * a password being viewed within minutes on a busy till. Security rows are kept for
 * SECURITY_RETENTION_DAYS instead, which follows India's CERT-In direction to keep system logs
 * for a rolling 180 days.
 *
 * Sign-in and the owner's own password change are recorded here explicitly: the /auth routes
 * are mounted before the activity logger (they must work without a session), so nothing else
 * sees them.
 *
 * Its own module, like credential-audit and the mail service: one place says what a security
 * event is, and the trim, the feed and the Security log screen all ask it.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const SECURITY_RETENTION_DAYS = 180;
/** Ordinary activity: the feed only ever shows the latest, so older rows are trimmed. */
export const ACTIVITY_ROWS_KEPT = 30;

/** Every row of these kinds is a security event. */
const SECURITY_ENTITY_TYPES = ['TEAM', 'USER_CREDENTIAL', 'ACCOUNT'] as const;
/** Of roles, only the changes: the "who does this affect?" preview is not an event. */
const SECURITY_ROLE_ACTIONS = ['CREATED', 'UPDATED', 'DELETED'] as const;
/** Of WhatsApp, linking and unlinking: they decide which number every bill goes out from. */
const SECURITY_WHATSAPP_ACTIONS = ['LINK', 'DISCONNECT'] as const;

export const isSecurityEvent = (entityType: string, action: string) =>
  (SECURITY_ENTITY_TYPES as readonly string[]).includes(entityType) ||
  (entityType === 'ROLE' && (SECURITY_ROLE_ACTIONS as readonly string[]).includes(action)) ||
  (entityType === 'WHATSAPP' && (SECURITY_WHATSAPP_ACTIONS as readonly string[]).includes(action));

/** The same rule as isSecurityEvent, for SQL. Kept beside it so the two cannot drift. */
const SECURITY_SQL = Prisma.sql`(entity_type IN (${Prisma.join([...SECURITY_ENTITY_TYPES])})
  OR (entity_type = 'ROLE' AND action IN (${Prisma.join([...SECURITY_ROLE_ACTIONS])}))
  OR (entity_type = 'WHATSAPP' AND action IN (${Prisma.join([...SECURITY_WHATSAPP_ACTIONS])})))`;

/**
 * Sign-ins belong in the Security log only. In the everyday feed "Anjali signed in" at every
 * till, every morning, would bury the changes people actually look there for.
 */
export const SECURITY_ONLY: ReadonlyArray<readonly [entityType: string, action: string]> = [
  ['ACCOUNT', 'SIGNED_IN'],
  ['ACCOUNT', 'SIGN_IN_FAILED'],
  ['ACCOUNT', 'SIGN_IN_BLOCKED']
];

/**
 * One statement, run after each recorded row: security rows older than the retention period go,
 * and ordinary activity is cut back to the newest ACTIVITY_ROWS_KEPT. A shop that goes quiet
 * keeps its old rows until its next recorded change -- kept too long, never too short.
 */
export async function pruneAuditLogs(clientId: string): Promise<void> {
  const cutoff = new Date(Date.now() - SECURITY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.$executeRaw`
    DELETE FROM audit_logs
    WHERE client_id = ${clientId}
      AND (
        (${SECURITY_SQL} AND created_at < ${cutoff})
        OR (NOT ${SECURITY_SQL} AND id NOT IN (
          SELECT id FROM audit_logs
          WHERE client_id = ${clientId} AND NOT ${SECURITY_SQL}
          ORDER BY created_at DESC
          LIMIT ${ACTIVITY_ROWS_KEPT}
        ))
      )`;
}

export type AccountEvent = 'SIGNED_IN' | 'SIGN_IN_FAILED' | 'SIGN_IN_BLOCKED' | 'PASSWORD_CHANGED' | 'SIGNED_OUT_OTHER_DEVICES';

/**
 * Records something that happened to one account. Never throws and is not awaited by callers:
 * a sign-in must not fail, or wait a database round trip, because its record could not be
 * written. (Contrast credential-audit, where a password is not shown unless its record is.)
 *
 * `actorUserId` is who did it -- absent when nobody is signed in, as with a wrong password.
 */
export function recordAccountEvent(event: {
  clientId: string;
  accountUserId: string;
  action: AccountEvent;
  actorUserId?: string | null;
  ipAddress?: string;
}): void {
  prisma.auditLog
    .create({
      data: {
        clientId: event.clientId,
        userId: event.actorUserId ?? null,
        action: event.action,
        entityType: 'ACCOUNT',
        entityId: event.accountUserId,
        ipAddress: event.ipAddress
      }
    })
    .then(() => pruneAuditLogs(event.clientId))
    .catch(err => console.error('security-log: failed to record an account event', err?.message));
}

/**
 * The sentence for each security event. {actor} is who did it and {target} what it was done to,
 * both by name. Written for the owner who opens this page because something feels wrong.
 */
const SENTENCES: Record<string, string> = {
  'ACCOUNT:SIGNED_IN': '{actor} signed in',
  'ACCOUNT:SIGN_IN_FAILED': 'Someone tried to sign in as {target} with a wrong password',
  'ACCOUNT:SIGN_IN_BLOCKED': 'Someone tried to sign in as {target}, whose account is switched off',
  'ACCOUNT:PASSWORD_CHANGED': '{actor} changed their own password',
  'ACCOUNT:SIGNED_OUT_OTHER_DEVICES': '{actor} signed out of every other device',
  'USER_CREDENTIAL:PASSWORD_VIEWED': "{actor} viewed {target}'s password",
  'USER_CREDENTIAL:PASSWORD_VIEW_REFUSED': "{actor} tried to view {target}'s password and was refused",
  'TEAM:MEMBERS': '{actor} added {target} to the team',
  'TEAM:ROLE': "{actor} changed {target}'s role",
  'TEAM:STATUS': '{actor} switched {target} on or off',
  'TEAM:PASSWORD': '{actor} set a new password for {target}',
  'TEAM:RESEND': "{actor} sent {target}'s sign-in details again",
  'ROLE:CREATED': '{actor} created the role {target}',
  'ROLE:UPDATED': '{actor} changed what the role {target} can do',
  'ROLE:DELETED': '{actor} deleted a role',
  'WHATSAPP:LINK': "{actor} started linking the shop's WhatsApp",
  'WHATSAPP:DISCONNECT': "{actor} unlinked the shop's WhatsApp"
};

/** Rows an owner should look at twice. */
const WARNINGS = new Set(['ACCOUNT:SIGN_IN_FAILED', 'ACCOUNT:SIGN_IN_BLOCKED', 'USER_CREDENTIAL:PASSWORD_VIEW_REFUSED']);

export type SecurityLogEntry = {
  id: string;
  at: Date;
  sentence: string;
  warning: boolean;
  ipAddress: string | null;
};

/**
 * One shop's security events, newest first, in pages. `before` is the `at` of the last row of
 * the previous page.
 */
export async function listSecurityLog(clientId: string, opts: { limit?: number; before?: Date } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const since = new Date(Date.now() - SECURITY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.auditLog.findMany({
    where: {
      clientId,
      createdAt: { gte: since, ...(opts.before ? { lt: opts.before } : {}) },
      OR: [
        { entityType: { in: [...SECURITY_ENTITY_TYPES] } },
        { entityType: 'ROLE', action: { in: [...SECURITY_ROLE_ACTIONS] } },
        { entityType: 'WHATSAPP', action: { in: [...SECURITY_WHATSAPP_ACTIONS] } }
      ],
      // The general logger's own row for a password view; credential-audit writes the real one.
      NOT: { entityType: 'TEAM', action: 'VIEW' }
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1
  });
  const page = rows.slice(0, limit);

  // Names, looked up once per page and only within this shop, so an id from anywhere else can
  // never be turned into somebody's name.
  const userIds = new Set<string>();
  const roleIds = new Set<string>();
  for (const r of page) {
    if (r.userId) userIds.add(r.userId);
    if (r.entityType === 'ROLE') roleIds.add(r.entityId);
    else if (r.entityType !== 'WHATSAPP') userIds.add(r.entityId);
  }
  const [users, roles] = await Promise.all([
    prisma.user.findMany({ where: { clientId, id: { in: [...userIds] } }, select: { id: true, name: true, email: true } }),
    roleIds.size
      ? prisma.role.findMany({ where: { clientId, id: { in: [...roleIds] } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: string; name: string }[])
  ]);
  const userName = new Map(users.map(u => [u.id, u.name || u.email]));
  const roleName = new Map(roles.map(r => [r.id, r.name]));

  const entries: SecurityLogEntry[] = page.map(r => {
    const key = `${r.entityType}:${r.action}`;
    const actor = (r.userId && userName.get(r.userId)) || (r.entityType === 'ACCOUNT' ? userName.get(r.entityId) : null) || 'Somebody';
    const target = r.entityType === 'ROLE'
      ? (roleName.get(r.entityId) ?? 'a role that has since been deleted')
      : (userName.get(r.entityId) ?? 'a team member');
    const template = SENTENCES[key] ?? '{actor} changed something about the team';
    return {
      id: r.id,
      at: r.createdAt,
      sentence: template.replace('{actor}', actor).replace('{target}', target),
      warning: WARNINGS.has(key),
      ipAddress: r.ipAddress ?? null
    };
  });

  return {
    entries,
    hasMore: rows.length > limit,
    keptForDays: SECURITY_RETENTION_DAYS
  };
}
