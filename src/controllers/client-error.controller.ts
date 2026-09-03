import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

// This route sits ahead of the global `authenticate` gate (see api.routes.ts) on purpose:
// a frontend error can happen before login resolves, or because auth itself is broken, and
// we still want to see it. So identity here is best-effort -- decode the session cookie if
// one is present, but never reject the request for a missing or invalid one.
function identifyFromCookie(req: Request): { clientId: string | null; userId: string | null } {
  try {
    const token = req.cookies?.token;
    if (!token) return { clientId: null, userId: null };
    const decoded = AuthService.verifyToken(token);
    return { clientId: decoded.clientId || null, userId: decoded.sub || null };
  } catch {
    return { clientId: null, userId: null };
  }
}

export const reportClientError = async (req: Request, res: Response) => {
  // Never let a malformed error report itself throw -- that would be a special kind of
  // embarrassing. Always 204, even on bad input.
  try {
    const { message, stack, route, userAgent } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(204).end();
    }

    const { clientId, userId } = identifyFromCookie(req);
    let userEmail: string | null = null;
    if (userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      userEmail = user?.email || null;
    }

    const log = await prisma.clientErrorLog.create({
      data: {
        clientId,
        userId,
        userEmail,
        source: 'FRONTEND',
        message: String(message).slice(0, 2000),
        stack: typeof stack === 'string' ? stack.slice(0, 8000) : null,
        route: typeof route === 'string' ? route.slice(0, 500) : null,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null
      },
      select: { id: true }
    });
    // The id lets the crash screen offer a one-click "Report this issue" that pre-fills a
    // support ticket linked back to this exact error.
    return res.status(201).json({ success: true, data: { id: log.id } });
  } catch (err) {
    console.error('Failed to persist client error report', err);
  }

  res.status(204).end();
};
