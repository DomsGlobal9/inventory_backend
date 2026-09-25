import { CampaignsScheduler } from './jobs/campaigns.scheduler';
import { PhotoJobsScheduler } from './jobs/photo-jobs.scheduler';
import express from 'express'; // Restart trigger 2
import cors from 'cors';
import { env } from './config/env';
import { requestLogger } from './middleware/request-logger';
import { linkHostGate, linkPathRouter } from './routes/link-open.routes';
import shopPublicRoutes from './routes/shop-public.routes';
import { shopHostGate } from './routes/shop-page.routes';
import { errorHandler } from './middleware/error.middleware';

import { prisma } from './lib/prisma';
import { tenantRateLimiter } from './middleware/rate-limiter.middleware';
import { SnapshotScheduler } from './jobs/snapshot.scheduler';
import { HousekeepingScheduler } from './jobs/housekeeping.scheduler';
import { WhatsAppDayBookScheduler } from './jobs/whatsapp-daybook.scheduler';
import { OfferMirrorWorker } from './services/shopify-discounts';
import { StorefrontDispatcherService } from './services/storefront-dispatcher.service';

import cookieParser from 'cookie-parser';
import helmet from 'helmet';

const app = express();

// Render (like any PaaS) terminates TLS at a load balancer and forwards the real client
// address in X-Forwarded-For. Without this, Express reports the proxy's address as req.ip
// for every request, which quietly breaks two things: express-rate-limit buckets every
// user together, so one caller can exhaust the limit for everybody, and the audit log
// records the proxy instead of whoever actually performed the action.
//
// Exactly one hop is trusted, not `true`. Trusting all hops would let a client set its own
// X-Forwarded-For and choose the identity used for rate limiting and audit records.
if (env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Global Middleware
app.use(helmet()); // HTTP Security Headers

// Short links. On go.scaleezy.com nothing else of this server is reachable; elsewhere /l/<code>.
// Ahead of CORS, cookies and body parsing: opening a link needs none of them.
app.use(linkHostGate);
app.use('/l', linkPathRouter);

// On shop.scaleezy.com this server IS the shop: the page a customer opens, with that shop's own
// link-preview tags in it, and the app's own files. Ahead of CORS and cookies, like the short-link
// host, because opening a shop needs none of them.
app.use(shopHostGate);

// Every shop's own online shop, as a shopper's browser uses it at shop.scaleezy.com/<slug>.
// Ahead of the app's CORS on purpose: this carries no cookies, so it is open to any origin -- the
// shop app today, a shop's own domain later. `credentials: false` is the whole safety of that: a
// browser will not attach anyone's session to these calls, so nothing here can act as anybody.
// POST is allowed because a customer buys here; what stops that being abused is the rate limit on
// those routes and the fact that placing an order proves nothing about who is asking.
app.use('/shop', cors({ origin: '*', credentials: false, methods: ['GET', 'POST'] }), shopPublicRoutes);
// The app's own origin, and only it, may send cookies.
const appCors = cors({
  origin: (origin, callback) => {
    if (env.NODE_ENV === 'development' && (!origin || origin.startsWith('http://localhost:'))) {
      callback(null, true);
    } else {
      callback(null, env.FRONTEND_URL);
    }
  },
  credentials: true,
});

/**
 * Try-On, scanned from a garment tag, is the one surface a DIFFERENT origin calls from a
 * customer's browser -- the try-on app, and in time a merchant's own storefront.
 *
 * It gets its own policy rather than being added to the one above, and the difference that
 * matters is `credentials: false`. Widening the shared policy to another origin WITH
 * credentials would let a script on that origin call every authenticated route carrying the
 * signed-in merchant's cookie. These routes read no cookie and return nothing private, so any
 * origin may call them and none may bring a session.
 *
 * CORS is not what protects this surface in any case -- a browser policy stops nothing that
 * curl can do. The rate limit and the shop's monthly allowance are the protection.
 */
const PUBLIC_TRYON_PATH = '/api/v1/public/tryon';
app.use(PUBLIC_TRYON_PATH, cors({ origin: true, credentials: false }));

// Everything else keeps the strict single-origin policy. Skipped for the path above rather
// than layered after it, because the later handler would otherwise overwrite the
// Access-Control-Allow-Origin the scoped one just set.
app.use((req, res, next) => {
  if (req.path.startsWith(PUBLIC_TRYON_PATH)) return next();
  return appCors(req, res, next);
});
app.use(cookieParser());
// Base64-encoded garment photos (up to 3-4 per generate-catalog call) comfortably
// exceed the default 100kb JSON limit -- raise it only for this path, ahead of the
// global parser below, so every other endpoint keeps the smaller DoS-safe default.
/*
 * The two routes that accept large bodies read them only from a caller carrying a login. The body is
 * parsed before authentication runs, so without this an anonymous caller could make the server read
 * 30 MB and only then be told to sign in. Presence only -- the login itself is still checked by the
 * route as before.
 */
const carriesLogin = (req: express.Request, res: express.Response, next: express.NextFunction) =>
  (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) || req.cookies?.token
    ? next()
    : res.status(401).json({ success: false, message: 'Unauthorized: Missing session token' });

app.use('/api/v1/catalog-tryon', carriesLogin, express.json({ limit: '30mb' }));
// Shopify signs its webhooks over the RAW BYTES of the body. express.json() would parse them
// away, and a re-serialised copy has different key order and whitespace, so the signature
// would never verify again -- the single most common way a Shopify integration fails. Mounted
// ahead of the global parser for that reason, exactly like the oversized path above.
// The cap is Shopify's own maximum webhook payload; anything larger is not from them.
app.use('/api/v1/shopify/webhooks', express.raw({ type: '*/*', limit: '5mb' }));
/*
 * A catalogue file is bigger than a form post.
 *
 * express.json() defaults to 100kb, which is generous for every other endpoint here and
 * far too small for an import: the service accepts up to 2000 rows, and a realistic row is
 * a couple of hundred bytes of JSON, so a merchant with a few hundred products was refused
 * with a bare 413 before any of the importer's own, friendlier limits were reached.
 *
 * Mounted before the default below, and scoped to the import routes only, so nothing else
 * gains a larger attack surface.
 */
app.use('/api/v1/products/import', carriesLogin, express.json({ limit: '10mb' }));

// WhatsApp: a document's PDF travels inside the send request (5 MB of PDF is ~7 MB of base64),
// and the service's events are signed over their raw bytes, like Shopify's above. Both scoped to
// their own paths so nothing else gains a larger body.
app.use('/api/v1/whatsapp/send', carriesLogin, express.json({ limit: '8mb' }));
app.use('/api/v1/whatsapp/events', express.raw({ type: '*/*', limit: '1mb' }));
// A campaign picture travels as base64 inside JSON: 15 MB of photo is about 20 MB encoded. Only for
// a signed-in caller, like the other large bodies above; the picture is checked and remade server-side.
app.use('/api/v1/campaigns/media', carriesLogin, express.json({ limit: '21mb' }),
  (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) =>
    err?.type === 'entity.too.large'
      ? res.status(413).json({ success: false, message: 'The picture is larger than 15 MB. Choose a smaller one.' })
      : next(err));

/*
 * Two more paths that carry a photograph, and one bug they shared.
 *
 * A banner and a counter try-on both travel as base64 inside JSON, so 15 MB of photo is about
 * 20 MB encoded -- and both were mounted with nothing but the 100kb default below, which every
 * real photograph exceeds. The symptom was a bare "request entity too large" with no hint of
 * which limit or why. Scoped to their own paths, like every other large body above, so nothing
 * else gains a bigger one; and each answers in words rather than with a bare 413.
 */
const tooBigIsSaidPlainly = (what: string) =>
  (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) =>
    err?.type === 'entity.too.large'
      ? res.status(413).json({ success: false, message: what })
      : next(err);

app.use('/api/v1/online-shop/banners', carriesLogin, express.json({ limit: '21mb' }),
  tooBigIsSaidPlainly('That picture is larger than 15 MB. Choose a smaller one.'));

// The shop's icon travels the same way as its banners, and was added without this -- so every
// real picture came back as a bare "request entity too large", which is the third time this
// exact mistake has been made on this file. A path that carries a photograph needs a line here.
app.use('/api/v1/online-shop/icon', carriesLogin, express.json({ limit: '21mb' }),
  tooBigIsSaidPlainly('That picture is larger than 15 MB. Choose a smaller one.'));

app.use('/api/v1/tryon', carriesLogin, express.json({ limit: '21mb' }),
  tooBigIsSaidPlainly('That photograph is larger than 15 MB. Take another one.'));

app.use(express.json());

/*
 * The NUL character (\u0000) in any text a request carries.
 *
 * Postgres refuses it in every text column and every comparison, so a search box sent "\u0000" -- or
 * a name containing one -- came back as a 500 from every search in the app, filling the console's
 * error log on demand. It has no meaning in anything a shop types; it is taken out before a route
 * sees the request.
 */
const stripNul = (value: any, depth = 0): any => {
  if (typeof value === 'string') return value.includes('\u0000') ? value.split('\u0000').join('') : value;
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = stripNul(value[i], depth + 1); return value; }
  for (const key of Object.keys(value)) value[key] = stripNul(value[key], depth + 1);
  return value;
};
app.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) stripNul(req.body);
  if (req.query && typeof req.query === 'object') stripNul(req.query);
  next();
});

app.use(requestLogger);

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness Check
app.get('/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ready', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'not_ready' });
  }
});

// Apply rate limiting to all /api routes
// Not Shopify's webhooks or a storefront's API. Shopify sends bursts from a handful of addresses and
// gives up on a store whose webhooks keep failing; every one is HMAC-verified before anything is
// read. A storefront has its own, higher limit per connection (storefront-public.routes). The
// WhatsApp Service's events come the same way -- a burst of ticks from one address, each signed.
app.use('/api', (req, res, next) =>
  /^\/v1\/(shopify|storefront)\/|^\/v1\/whatsapp\/events$/.test(req.path) ? next() : tenantRateLimiter(req, res, next));

// Every response here is per-authenticated-user data (never a static public asset),
// and Express auto-generates an ETag on JSON bodies by default. Without an explicit
// no-store, a browser can and does reuse a cached GET response across a session
// switch on the same device -- e.g. a platform admin assuming one client's session
// after another, or any shared/kiosk browser -- silently showing one tenant's data
// under a different tenant's login. Confirmed live: this is what happened.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

import apiRoutes from './routes/api.routes';

// Mount Routes
app.use('/api/v1', apiRoutes);
// Global Error Handler (Must be last)
app.use(errorHandler);

const PORT = env.PORT;

app.listen(PORT, () => {
  console.log(`🚀 Inventory Microservice running on port ${PORT}`);
  // The old single-destination webhook poller is not started. It read one global
  // STOREFRONT_WEBHOOK_URL for every tenant, carried no clientId, and claimed rows before
  // checking it had somewhere to send them -- which is why all 747 of its events are stranded.
  // StorefrontDispatcherService replaces it; inventory_events stops growing from here.
  // The daily snapshot job existed but nothing ever called it, so the trend chart was fed
  // only by the old fabricating backfill.
  // A second instance pointed at the same database must serve requests without also running
  // the clock -- two dispatchers claim the same events and two schedulers write the same
  // closing snapshots. See DISABLE_BACKGROUND_JOBS in config/env.
  if (env.DISABLE_BACKGROUND_JOBS) {
    console.log('   background jobs disabled for this instance (DISABLE_BACKGROUND_JOBS)');
  } else {
    SnapshotScheduler.start();
    StorefrontDispatcherService.start();
    HousekeepingScheduler.start();
    WhatsAppDayBookScheduler.start();
    CampaignsScheduler.start();
    OfferMirrorWorker.start();
  }

  /*
   * Asked separately, and outside that switch on purpose.
   *
   * DISABLE_BACKGROUND_JOBS exists because two instances must not both write the same closing
   * snapshot or claim the same storefront event -- work where running twice is the bug. Photo
   * jobs are not that shape: a job is claimed with a conditional update, so a second instance
   * either wins it or is told it changed nothing.
   *
   * It still honours the switch by default, so production behaves exactly as it did. What this
   * allows is the one case the switch cannot express: a development machine that must NOT run
   * the clock, but does need to run photo jobs for a single test shop. The worker reads both
   * PHOTO_JOBS_IN_DEV and PHOTO_JOBS_ONLY_CLIENTS and decides for itself.
   */
  PhotoJobsScheduler.start();
});
