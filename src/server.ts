import express from 'express'; // Restart trigger 2
import cors from 'cors';
import { env } from './config/env';
import { requestLogger } from './middleware/request-logger';
import { errorHandler } from './middleware/error.middleware';

import { prisma } from './lib/prisma';
import { tenantRateLimiter } from './middleware/rate-limiter.middleware';
import { SnapshotScheduler } from './jobs/snapshot.scheduler';
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
app.use(cors({
  origin: (origin, callback) => {
    if (env.NODE_ENV === 'development' && (!origin || origin.startsWith('http://localhost:'))) {
      callback(null, true);
    } else {
      callback(null, env.FRONTEND_URL);
    }
  },
  credentials: true,
}));
app.use(cookieParser());
// Base64-encoded garment photos (up to 3-4 per generate-catalog call) comfortably
// exceed the default 100kb JSON limit -- raise it only for this path, ahead of the
// global parser below, so every other endpoint keeps the smaller DoS-safe default.
app.use('/api/v1/catalog-tryon', express.json({ limit: '30mb' }));
// Shopify signs its webhooks over the RAW BYTES of the body. express.json() would parse them
// away, and a re-serialised copy has different key order and whitespace, so the signature
// would never verify again -- the single most common way a Shopify integration fails. Mounted
// ahead of the global parser for that reason, exactly like the oversized path above.
// The cap is Shopify's own maximum webhook payload; anything larger is not from them.
app.use('/api/v1/shopify/webhooks', express.raw({ type: '*/*', limit: '5mb' }));
app.use(express.json());
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
app.use('/api', tenantRateLimiter);

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
  SnapshotScheduler.start();
  StorefrontDispatcherService.start();
});
