import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Keep every client's activity feed bounded -- without this, a busy warehouse doing
// hundreds of stock moves a day would grow this table forever. 30 is generous for "what
// has my team been doing lately" without needing real log-retention infrastructure.
const ROLLING_LIMIT_PER_CLIENT = 30;

function looksLikeId(segment: string) {
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment) || /^[0-9a-f]{20,}$/i.test(segment) || /^\d+$/.test(segment);
}

// Infers a human-readable action + entity purely from the HTTP method and route path, e.g.
// POST /products -> CREATED / PRODUCT, POST /purchase-orders/:id/receive -> RECEIVE /
// PURCHASE_ORDER. Approximate by design -- this is an activity feed for a platform admin
// to skim, not a byte-exact record, so it doesn't need every controller to opt in.
function inferActionAndEntity(method: string, path: string) {
  const segments = path.split('/').filter(Boolean);
  const resource = segments[0] || 'unknown';
  const entityType = resource.replace(/-/g, '_').toUpperCase().replace(/S$/, '');

  const last = segments[segments.length - 1];
  let action: string;
  if (segments.length > 1 && last && !looksLikeId(last) && last !== resource) {
    action = last.replace(/-/g, '_').toUpperCase();
  } else if (method === 'POST') {
    action = 'CREATED';
  } else if (method === 'DELETE') {
    action = 'DELETED';
  } else {
    action = 'UPDATED';
  }

  const entityId = segments.find(looksLikeId) || segments[1] || 'n/a';
  return { action, entityType, entityId };
}

async function pruneOldLogs(clientId: string) {
  const count = await prisma.auditLog.count({ where: { clientId } });
  if (count <= ROLLING_LIMIT_PER_CLIENT) return;

  const oldest = await prisma.auditLog.findMany({
    where: { clientId },
    orderBy: { createdAt: 'asc' },
    take: count - ROLLING_LIMIT_PER_CLIENT,
    select: { id: true }
  });
  await prisma.auditLog.deleteMany({ where: { id: { in: oldest.map(o => o.id) } } });
}

export const auditLogger = (req: Request, res: Response, next: NextFunction) => {
  if (!MUTATION_METHODS.has(req.method)) return next();

  // Captured now, before this request is dispatched into a mounted sub-router -- Express
  // rewrites req.url (and therefore req.path) while it's inside a `router.use('/x', ...)`
  // mount, so reading req.path later inside the 'finish' handler below would see whatever
  // the deepest sub-router left it as, not the full path from here.
  const method = req.method;
  const path = req.path;

  res.on('finish', () => {
    // Only log what actually succeeded -- a rejected/failed mutation isn't "activity".
    if (res.statusCode >= 400) return;

    const user = (req as any).user;
    if (!user?.clientId) return;

    const { action, entityType, entityId } = inferActionAndEntity(method, path);

    prisma.auditLog.create({
      data: { clientId: user.clientId, userId: user.id, action, entityType, entityId, ipAddress: req.ip }
    })
      .then(() => pruneOldLogs(user.clientId))
      .catch(err => console.error('audit-logger: failed to record activity', err));
  });

  next();
};
