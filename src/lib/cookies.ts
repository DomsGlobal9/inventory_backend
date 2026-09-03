import { env } from '../config/env';

/**
 * Session cookie attributes, defined once.
 *
 * These were duplicated across auth.controller.ts and platform-admin.controller.ts, and
 * every copy hardcoded SameSite=Lax -- one of them as the literally inert
 * `(isProd ? 'lax' : 'lax')`, where the intent to differentiate production clearly existed
 * but both branches said the same thing.
 *
 * Lax is correct while the frontend and API share an origin (localhost during development).
 * In production they do not: the app is served from Vercel and the API from Render, which
 * are different sites, and a browser will not attach a Lax cookie to a cross-site request.
 * The symptom is nasty precisely because nothing errors -- login returns 200 and sets the
 * cookie, then every following request arrives unauthenticated and the user is bounced back
 * to the login screen with no explanation.
 *
 * SameSite=None is what permits the cross-site send, and browsers only honour it together
 * with Secure, which is why the two move as a pair below.
 */
const isProd = env.NODE_ENV === 'production';

type SameSite = 'lax' | 'strict' | 'none';

const base = {
  httpOnly: true,
  secure: isProd,
  sameSite: (isProd ? 'none' : 'lax') as SameSite,
  path: '/'
};

/** Client session cookie. 24h, matching the JWT's own expiry. */
export const authCookieOptions = { ...base, maxAge: 24 * 60 * 60 * 1000 };

/** Platform admin console cookie. 8h. */
export const platformAdminCookieOptions = { ...base, maxAge: 8 * 60 * 60 * 1000 };

/**
 * Attributes for clearing either cookie.
 *
 * A cookie is only removed when the clear matches the attributes it was set with, so this
 * must track the options above. maxAge is deliberately absent: clearCookie merges the
 * caller's options over its own `expires: new Date(1)`, and res.cookie then recomputes
 * expires from maxAge -- passing one through re-issues the cookie instead of deleting it.
 */
export const clearCookieOptions = base;
