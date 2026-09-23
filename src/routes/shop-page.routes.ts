import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { onlineShop } from '../services/online-shop';
import shopPublicRoutes from './shop-public.routes';

/**
 * Serving the shop a customer sees, at `shop.scaleezy.com/<slug>`.
 *
 * Why the backend and not a static host: a shop's whole way of selling in Phase 1 is to send its
 * link on WhatsApp. WhatsApp fetches that page to draw its preview card -- the shop's name and a
 * photo -- and a single-page app hands it an empty shell, so the message arrives as a bare link
 * that looks like spam and nobody taps. The tags have to be in the HTML, per shop, which means
 * whatever serves the page needs the data.
 *
 * The app itself is a plain static bundle (`shop/dist`), so putting a CDN in front of this later
 * changes nothing in the app.
 */

const router = Router();

/*
 * The shopper-facing app, built from `shop/` in this repo (its own module, like whatsapp-service).
 * It has to live inside this service because this service serves it: a shop link opened in
 * WhatsApp needs the page's OG tags filled in for THAT shop before any JavaScript runs, which a
 * static host cannot do.
 *
 * `../../shop/dist` lands in the same place either way: from `src/routes` while developing, and
 * from `dist/routes` once compiled.
 */
const SHOP_DIST = path.resolve(__dirname, '../../shop/dist');
const INDEX = path.join(SHOP_DIST, 'index.html');

/** Nothing a shop types may become markup in its own page, or anyone else's. */
const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The bundle's own tags, replaced with this shop's.
 *
 * Read fresh in development so an edit shows without a restart, and once in production because it
 * never changes between deploys and a shopper should not wait on a disk read.
 */
let cached: string | null = null;
function shell(): string | null {
  if (process.env.NODE_ENV === 'production' && cached) return cached;
  if (!existsSync(INDEX)) return null;
  const html = readFileSync(INDEX, 'utf8');
  if (process.env.NODE_ENV === 'production') cached = html;
  return html;
}

function withTags(html: string, tags: Record<string, string>, title: string, description: string) {
  const meta = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    ...Object.entries(tags).map(([k, v]) =>
      (k.startsWith('og:') || k.startsWith('article:')
        ? `<meta property="${esc(k)}" content="${esc(v)}" />`
        : `<meta name="${esc(k)}" content="${esc(v)}" />`))
  ].join('\n    ');

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '')
    .replace('</head>', `  ${meta}\n  </head>`);
}

/**
 * A shop's page, or one of its products.
 *
 * A closed or unknown shop still gets the app -- it has its own words for both, and they are
 * kinder than a bare error page -- but the preview tags say nothing about a shop that is not
 * open, so a stale link shared onwards does not advertise a shut shop.
 */
async function page(req: Request, res: Response) {
  const html = shell();
  if (!html) {
    return res.status(503).type('text/plain').send('The shop is not built yet. Run `npm run build` in shop/.');
  }

  const slug = String(req.params.slug ?? '');
  const shop = await onlineShop.publicShop(slug).catch(() => ({ state: 'UNKNOWN' as const }));

  res.set('Cache-Control', 'no-store');

  if (shop.state !== 'OPEN') {
    // No preview worth drawing, and deliberately nothing that names a shop which is not open.
    return res.type('html').send(withTags(html, { robots: 'noindex' }, 'Shop', 'This shop is not open.'));
  }

  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const code = String(req.params.productCode ?? '');
  let title = shop.name;
  let description = `Shop online with ${shop.name}.`;
  /*
   * The picture WhatsApp shows beside the link. The shop's first banner is the shop's own choice
   * of what it looks like, so it comes before the old single banner picture and before the logo --
   * a logo on its own makes a rather flat preview next to a photograph of a saree.
   */
  let image = shop.banners?.[0]?.imageUrl ?? shop.bannerUrl ?? shop.logoUrl ?? '';

  if (code) {
    const product = await onlineShop.publicProduct(shop, code).catch(() => null);
    if (product) {
      title = `${product.title} · ${shop.name}`;
      description = product.description?.trim()
        || [product.fabric, product.dressType].filter(Boolean).join(' · ')
        || `${product.title} at ${shop.name}.`;
      image = product.images?.find(i => i.isPrimary)?.url ?? product.images?.[0]?.url ?? image;
    }
  }

  res.type('html').send(withTags(html, {
    'og:type': code ? 'product' : 'website',
    'og:site_name': shop.name,
    'og:title': title,
    'og:description': description,
    'og:url': url,
    ...(image ? { 'og:image': image } : {}),
    'twitter:card': image ? 'summary_large_image' : 'summary',
    // A shop's own pages are its own to index; ScaleEzy does not claim them.
    robots: 'index, follow'
  }, title, description));
}

/**
 * The catalogue, on the shop's OWN address.
 *
 * The app could call the backend's address instead, but then every shopper pays for a cross-origin
 * request and the page needs permission to reach another host. Same origin is simpler, faster on a
 * phone, and means the shop page needs no permission to talk to anything but itself.
 */
router.use('/_api/shop', shopPublicRoutes);

/**
 * What a shop page is allowed to load.
 *
 * Helmet's default for this server is `default-src 'self'`, which is right for the app and wrong
 * here: a shop's photos live in ScaleEzy's picture storage, on another host, so with that default
 * every product would show an empty square. This is the narrowest set that lets a shop page work:
 * pictures from anywhere over https (they are the shop's own, wherever they are hosted), and
 * everything else from here.
 */
router.use((_req, res, next) => {
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: https:",
    // The app styles components inline, as the rest of this codebase does.
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'"
  ].join('; '));
  next();
});

/** The built app's files. Long-lived because Vite fingerprints every name it emits. */
router.use('/assets', express.static(path.join(SHOP_DIST, 'assets'), {
  immutable: true,
  maxAge: '1y',
  fallthrough: true
}));

router.get('/', (_req, res) => {
  const html = shell();
  if (!html) return res.status(503).type('text/plain').send('The shop is not built yet.');
  res.set('Cache-Control', 'no-store').type('html').send(
    withTags(html, { robots: 'noindex' }, 'ScaleEzy shops', 'Shops on this address are run by their own owners.')
  );
});

router.get('/:slug', page);
router.get('/:slug/p/:productCode', page);
/*
 * Any other path inside a shop is still that shop's app -- the bag, the checkout, a customer's own
 * order -- and the app decides what to show.
 *
 * `'/:slug/*'`, not `'/:slug/*splat'`. This server runs Express 4, where the wildcard is a bare
 * `*`; the named form belongs to Express 5. Written the other way it matched nothing, and every
 * page but the front page and a product answered "Cannot GET".
 */
router.get('/:slug/*', page);

/**
 * On shop.scaleezy.com, this server is the shop and nothing else.
 *
 * The same shape as the short-link host gate, for the same reason: an address thousands of
 * customers open should not also answer for the API or the console. Everything here is a GET of a
 * page or of the bundle's own files; anything else is simply not this host's business.
 */
export function shopHostGate(req: Request, res: Response, next: NextFunction) {
  const host = onlineShop.shopHost();
  if (!host || req.hostname?.toLowerCase() !== host) return next();

  /*
   * Everything a shopper LOOKS at is a GET. The one thing they SEND is a purchase -- pricing the
   * bag and placing the order -- and that is a POST to this host's own little API. Without this
   * the gate refused every checkout on shop.scaleezy.com with a bare 405, while the same calls
   * worked on the API host: the shop would have looked perfect and sold nothing.
   *
   * Nothing else on this host takes anything but a GET.
   */
  const buying = req.method === 'POST' && req.path.startsWith('/_api/shop/');
  if (!buying && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).type('text/plain').send('Not allowed here.');
  }
  return router(req, res, next);
}

export default router;
