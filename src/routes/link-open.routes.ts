import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { links } from '../services/links';
import { page } from '../services/links/pages';

/**
 * Opening a short link: the only thing a visitor to go.scaleezy.com can do.
 *
 * On the short-link host every path is handled here and nothing else of this server is reachable
 * -- go.scaleezy.com/api/... is a "not available" page, never the API. The same codes also open at
 * /l/<code> on this server's own address, for local work and for links made before the host is set.
 */

// Per visitor address, in memory only (never stored). Enough for a family on one Wi-Fi opening a
// campaign; far too few to walk through codes looking for live ones.
const openLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.LINK_OPEN_RATE_MAX) > 0 ? Number(process.env.LINK_OPEN_RATE_MAX) : 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => sendPage(res, 429, page('TOO_MANY'))
});

function sendPage(res: Response, status: number, html: string) {
  res
    .status(status)
    .set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' })
    .send(html);
}

async function openCode(req: Request, res: Response) {
  try {
    const result = await links.open(String(req.params.code ?? ''), { method: req.method, userAgent: req.get('user-agent') });
    if (result.kind === 'page') return sendPage(res, result.status, result.html);
    // No caching anywhere: a link switched off or expired must stop at once, and every tap counts.
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    return res.redirect(302, result.location);
  } catch (e) {
    console.error('[links] open failed:', (e as Error)?.message);
    return sendPage(res, 503, page('UNAVAILABLE'));
  }
}

const onlyReads = (req: Request, res: Response, next: NextFunction) =>
  req.method === 'GET' || req.method === 'HEAD' ? next() : sendPage(res, 405, page('UNAVAILABLE'));

/** /l/<code> on this server's own address. */
export const linkPathRouter = Router();
linkPathRouter.use(onlyReads);
linkPathRouter.get('/:code', openLimiter, openCode);
linkPathRouter.use((_req, res) => sendPage(res, 404, page('UNAVAILABLE')));

/**
 * Everything on the short-link host. Mounted before the rest of the app; every other host passes
 * straight through untouched.
 */
export function linkHostGate(req: Request, res: Response, next: NextFunction) {
  const host = links.linkHost();
  if (!host || req.hostname?.toLowerCase() !== host) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendPage(res, 405, page('UNAVAILABLE'));
  if (req.path === '/robots.txt') {
    return res.status(200).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }).send('User-agent: *\nDisallow: /\n');
  }
  if (req.path === '/') return sendPage(res, 200, page('HOME'));
  const m = /^\/([A-Za-z0-9]{7})\/?$/.exec(req.path);
  if (!m) return sendPage(res, 404, page('UNAVAILABLE'));
  req.params = { code: m[1] };
  return openLimiter(req, res, () => void openCode(req, res));
}
