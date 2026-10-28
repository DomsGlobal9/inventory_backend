import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/**
 * A change made with the login cookie must come from our own app.
 *
 * In production the session cookie is SameSite=None (the app and the API are on different sites,
 * see lib/cookies.ts), so the browser attaches it to requests that OTHER websites start too. CORS
 * stops those sites reading the answer, not the request itself: a hidden form on any page could
 * POST to /online-shop/close and the owner's shop went offline (security review, 28 Oct). Routes
 * that need a JSON body were safe -- a form cannot send one -- but every action that needs no body
 * was not.
 *
 * So: a write that carries a login cookie and says it came from another site is refused. Callers
 * that sign in with a Bearer header (POS, scripts, the Android app) are not affected; a forged
 * page cannot set that header. Reads are not affected.
 */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

const originOf = (url: string) => {
  try { return new URL(url).origin; } catch { return null; }
};
const appOrigin = originOf(env.FRONTEND_URL);

function allowed(origin: string): boolean {
  if (origin === appOrigin) return true;
  return env.NODE_ENV === 'development' && /^http:\/\/localhost(:\d+)?$/.test(origin);
}

export const sameSiteWrites = (req: Request, res: Response, next: NextFunction) => {
  if (READS.has(req.method)) return next();
  const carriesCookie = !!(req.cookies?.token || req.cookies?.platform_admin_token);
  const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');
  if (!carriesCookie || bearer) return next();

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
  // Browsers send Origin on every cross-site POST; an older one that does not still says where the
  // request came from in Sec-Fetch-Site.
  const crossSite = origin ? !allowed(origin) : req.headers['sec-fetch-site'] === 'cross-site';
  if (crossSite) {
    return res.status(403).json({ success: false, message: 'This request did not come from the ScaleEzy app, so it was not carried out.' });
  }
  next();
};
