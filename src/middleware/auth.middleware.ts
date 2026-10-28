import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { loadIdentity } from '../lib/identityCache';

export interface UserWithRoles {
  id: string;
  clientId: string;
  name?: string;
  email?: string;
  roles: string[];
  permissions: string[];
}

/**
 * The one check of a login token: signature, issuer and audience, then against stored state on
 * every call rather than trusted from the token -- a deactivated user with a valid token is still
 * refused, as is one from another shop or from before the session number moved (password changed,
 * account switched off, "sign out of other devices"; a token from before session numbers is 0).
 * The stored state comes from identityCache.ts, which explains what invalidates it.
 *
 * Shared by this middleware and by the service route other modules ask "who is this?" (CRM), so the
 * two can never answer differently.
 */
export async function identityFromToken(token: string): Promise<{ ok: true; user: UserWithRoles } | { ok: false; reason: 'token' | 'identity' | 'ended' }> {
  let decoded: any;
  try { decoded = AuthService.verifyToken(token); } catch { return { ok: false, reason: 'token' }; }
  const user = await loadIdentity(decoded.sub);
  if (!user || user.status !== 'ACTIVE' || user.clientId !== decoded.clientId) return { ok: false, reason: 'identity' };
  if ((typeof decoded.sv === 'number' ? decoded.sv : 0) !== user.sessionVersion) return { ok: false, reason: 'ended' };
  return {
    ok: true,
    user: { id: user.id, clientId: user.clientId, name: user.name ?? undefined, email: user.email, roles: user.roles, permissions: user.permissions }
  };
}

export const verifyLocalAssertion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // The x-internal-service-key bypass that used to sit here has been removed. It set
    // `req.isServiceRequest = true` and called next() WITHOUT populating `req.user` --
    // and nothing in the entire codebase ever read that flag. Routes behind
    // tenantMiddleware/requirePermission then 401'd on the missing identity, but
    // /support-tickets has neither guard and dereferenced `user.clientId` straight into
    // an uncaught TypeError, i.e. a header-only path past authentication.
    // Service-to-service traffic already has a real, scoped home: /api/v1/internal,
    // guarded by verifyServiceToken, which sets an actual `req.service` principal.

    // Local Auth Mode (Phase 1 & 2.5)
    let token = req.cookies?.token;

    // Explicit Fallback for CLI, internal API clients, and automated testing ONLY.
    // The browser frontend should never use this fallback.
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing session token' });
    }

    const found = await identityFromToken(token);
    if (!found.ok) {
      return res.status(401).json({ success: false, message: found.reason === 'ended' ? 'Unauthorized: This sign-in has ended. Sign in again.' : found.reason === 'token' ? 'Unauthorized: Invalid or expired token' : 'Unauthorized: Invalid identity or inactive user' });
    }
    (req as any).user = found.user;

    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or expired token' });
  }
};

import { verifyGatewayAssertion } from './gateway.middleware';
import { env } from '../config/env';

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  // Reject Service JWTs from human authentication routes explicitly
  const authHeader = req.headers.authorization || '';
  if (authHeader.includes('inventory-service') || req.headers['x-is-service-account']) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Service JWTs cannot be used for human routes' });
  }

  if (env.AUTH_MODE === 'gateway') {
    return verifyGatewayAssertion(req, res, next);
  } else {
    return verifyLocalAssertion(req, res, next);
  }
};
