import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { platformAuditService } from '../services/platform-audit.service';

/**
 * Records every console action a platform admin takes.
 *
 * Middleware rather than a call inside each controller, on purpose: a trail you have to
 * remember to add is a trail that is missing from whichever route was written in a hurry. This
 * sits on the console router, so a new console mutation is recorded the day it is added --
 * with a generic action name until someone gives it a better one below, which is the right way
 * round for a gap to show up.
 *
 * The sibling audit-logger.middleware does this for client users. It cannot cover the console:
 * it keys every row on req.user.clientId, and a platform admin has no clientId -- they are a
 * separate auth realm entirely. Every console mutation fell straight through it.
 */

/**
 * Route to action, spelled out rather than inferred.
 *
 * The client-side logger infers names from the URL because it covers hundreds of routes. There
 * are seventeen here and each one deserves a name a person can read in a list, because the
 * list is what someone scans when they are worried.
 */
const ROUTES: { method: string; pattern: RegExp; action: string; targetType: string }[] = [
  { method: 'POST',   pattern: /^\/users\/([^/]+)\/password\/view$/, action: 'VIEW_PASSWORD',                 targetType: 'USER' },
  { method: 'POST',   pattern: /^\/users\/([^/]+)\/password$/,       action: 'RESET_USER_PASSWORD',           targetType: 'USER' },
  { method: 'POST',   pattern: /^\/clients$/,                        action: 'ONBOARD_CLIENT',                targetType: 'CLIENT' },
  { method: 'POST',   pattern: /^\/clients\/([^/]+)\/assume$/,       action: 'ASSUME_CLIENT',                 targetType: 'CLIENT' },
  { method: 'PATCH',  pattern: /^\/clients\/([^/]+)\/suspend$/,      action: 'SUSPEND_CLIENT',                targetType: 'CLIENT' },
  { method: 'DELETE', pattern: /^\/clients\/([^/]+)$/,               action: 'DELETE_CLIENT',                 targetType: 'CLIENT' },
  { method: 'POST',   pattern: /^\/clients\/([^/]+)\/service-keys$/, action: 'SET_SERVICE_KEY',               targetType: 'CLIENT' },
  { method: 'DELETE', pattern: /^\/clients\/([^/]+)\/service-keys$/, action: 'REVOKE_SERVICE_KEY',            targetType: 'CLIENT' },
  { method: 'PATCH',  pattern: /^\/clients\/([^/]+)\/tryon-limit$/,  action: 'SET_TRYON_LIMIT',               targetType: 'CLIENT' },
  { method: 'POST',   pattern: /^\/sessions\/([^/]+)\/end$/,         action: 'END_ASSUMED_SESSION',           targetType: 'SESSION' },
  { method: 'POST',   pattern: /^\/platform-admins$/,                action: 'CREATE_PLATFORM_ADMIN',         targetType: 'PLATFORM_ADMIN' },
  { method: 'PATCH',  pattern: /^\/platform-admins\/([^/]+)\/status$/,   action: 'SET_PLATFORM_ADMIN_STATUS',     targetType: 'PLATFORM_ADMIN' },
  { method: 'POST',   pattern: /^\/platform-admins\/([^/]+)\/password$/, action: 'RESET_PLATFORM_ADMIN_PASSWORD', targetType: 'PLATFORM_ADMIN' },
  { method: 'POST',   pattern: /^\/support-tickets\/([^/]+)\/messages$/, action: 'REPLY_SUPPORT_TICKET',          targetType: 'SUPPORT_TICKET' },
  { method: 'PATCH',  pattern: /^\/support-tickets\/([^/]+)$/,       action: 'UPDATE_SUPPORT_TICKET',         targetType: 'SUPPORT_TICKET' },
  { method: 'PATCH',  pattern: /^\/leads\/([^/]+)$/,                 action: 'UPDATE_LEAD',                   targetType: 'LEAD' },
  { method: 'POST',   pattern: /^\/leads\/([^/]+)\/convert$/,        action: 'CONVERT_LEAD',                  targetType: 'LEAD' }
];

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Turns an id into something readable, so the log says whose password was read rather than a
 * uuid somebody then has to go and look up. Runs after the response has been sent, so it costs
 * the admin nothing; a lookup that fails just leaves the label empty.
 */
async function labelFor(targetType: string, targetId?: string): Promise<string | null> {
  if (!targetId) return null;
  try {
    if (targetType === 'USER') {
      const u = await prisma.user.findUnique({ where: { id: targetId }, select: { email: true, clientId: true } });
      return u ? `${u.email} (${u.clientId})` : null;
    }
    if (targetType === 'PLATFORM_ADMIN') {
      const a = await prisma.platformAdmin.findUnique({ where: { id: targetId }, select: { email: true } });
      return a?.email ?? null;
    }
    if (targetType === 'LEAD') {
      const l = await prisma.signupLead.findUnique({ where: { id: targetId }, select: { companyName: true } });
      return l?.companyName ?? null;
    }
    if (targetType === 'SUPPORT_TICKET') {
      const t = await prisma.supportTicket.findUnique({ where: { id: targetId }, select: { ticketNumber: true, clientId: true } });
      return t ? `${t.ticketNumber ?? targetId} (${t.clientId})` : null;
    }
    // A CLIENT's id is already the name people use for it in this product.
    return targetId;
  } catch {
    return null;
  }
}

export const platformAuditLogger = (req: Request, res: Response, next: NextFunction) => {
  if (!MUTATIONS.has(req.method)) return next();

  // Read before Express rewrites req.url inside the mounted sub-router, the same trap
  // audit-logger.middleware documents.
  const method = req.method;
  const path = req.path;

  res.on('finish', () => {
    // A rejected action is not something that happened. Failed sign-in attempts and the like
    // belong to a different kind of log than "what was done".
    if (res.statusCode >= 400) return;

    const admin = (req as any).platformAdmin;
    if (!admin?.id) return;

    let action = `${method}_${path}`;
    let targetType = 'UNKNOWN';
    let targetId: string | undefined;

    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const m = path.match(route.pattern);
      if (m) {
        action = route.action;
        targetType = route.targetType;
        targetId = m[1];
        break;
      }
    }

    // Some targets do not exist until the handler has run, so there is nothing in the URL to
    // capture. Creating a client is the obvious one: POST /clients has no id in it, and the
    // trail was recording "somebody created a client" with no way to tell which -- which is
    // most of the point of having the line at all.
    //
    // A handler can name its own target by setting res.locals.auditTargetId (and optionally a
    // label). Nothing is required to; where it is absent the URL capture still applies.
    const named = (res as any).locals?.auditTargetId;
    if (named) targetId = String(named);

    // Deliberately not awaited: the response has already gone, and making the admin wait on
    // the audit write would be a reason to want it removed.
    const namedLabel = (res as any).locals?.auditTargetLabel;

    labelFor(targetType, targetId)
      .then(targetLabel => platformAuditService.record({
        platformAdminId: admin.id,
        adminEmail: admin.email,
        adminName: admin.name,
        action,
        targetType,
        targetId,
        targetLabel: namedLabel ?? targetLabel,
        ipAddress: req.ip
      }))
      .catch(err => console.error('[platform-audit] middleware failed', err));
  });

  next();
};
