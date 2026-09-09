import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Boot-time environment validation.
 *
 * The rule this file exists to enforce: a misconfigured deployment must fail HERE, loudly,
 * with the variable named -- never silently boot and then 500 on a user's first real action.
 *
 * Previously only 9 variables were validated. Five more were read directly through
 * process.env elsewhere in the codebase and bypassed this entirely, and the worst of them
 * was CREDENTIAL_ENCRYPTION_KEY: with it missing the service booted, passed health checks
 * and looked fine, then threw the first time anyone onboarded a client or viewed a staff
 * password. A boot failure is a five-minute fix; that is a production incident.
 *
 * Dev stays frictionless -- the strict requirements below apply only when
 * NODE_ENV=production, so nothing changes for local work.
 */

const isProd = process.env.NODE_ENV === 'production';

// A variable left blank in a hosting dashboard arrives as "" rather than undefined, which
// would fail a format check ("must be a valid URL") AND the required check, reporting the
// same missing value twice under two different reasons. Normalise blank to absent so the
// message is the single actionable one.
const optionalStr = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Render (and most PaaS) inject PORT at runtime; the default is for local only.
  PORT: z.string().transform(Number).default('4006'),

  /**
   * Turns off the snapshot and storefront-dispatch schedulers for this process.
   *
   * Needed to run a second copy of this service against the same database -- for local UI
   * work against real data, or a one-off debugging instance. Without it that second copy
   * competes with the deployed one: two dispatchers claiming the same events, two schedulers
   * writing the same closing snapshots. Serving requests is safe to duplicate; running the
   * clock is not.
   *
   * Off by default, so a deployment that never sets it keeps both jobs.
   */
  DISABLE_BACKGROUND_JOBS: z.preprocess(
    (v) => v === 'true' || v === true,
    z.boolean().default(false)
  ),

  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  // Declared by prisma/schema.prisma as `directUrl`. Only migrations use it, so it is not
  // required to boot -- but without it `prisma migrate deploy` fails on the deploy host,
  // which is a confusing place to discover it.
  DIRECT_URL: optionalStr(z.string().url("DIRECT_URL must be a valid URL")),

  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),

  // Used for the CORS allow-list. The localhost default is correct for dev and actively
  // wrong in production: it silently rejects every request from the deployed frontend,
  // which shows up as inexplicable browser CORS errors while curl works fine.
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  AUTH_MODE: z.enum(['local', 'gateway']).default('local'),
  GATEWAY_PUBLIC_KEY_PATH: z.string().optional(),
  INVENTORY_PRIVATE_KEY_PATH: z.string().optional(),
  TRUSTED_SERVICES_KEYS: z.string().optional().transform(str => {
    if (!str) return {};
    try { return JSON.parse(str); } catch (e) { return {}; }
  }),

  // --- Try-On ------------------------------------------------------------------------
  //
  // Two services through the same gateway, each with its own key per client, pasted into the
  // console. The keys below are only the SHARED fallback used by a client who has not been
  // given one of their own -- see credential.service.ts.
  //
  // 4-View Catalog Try-On: the merchant's tool, one garment photo in, four catalogue views out.
  CATALOG_TRYON_GATEWAY_URL: z.string().url().optional(),
  CATALOG_TRYON_API_KEY: z.string().optional(),

  // Try-On: the shopper's tool, reached by scanning the QR code on a product.
  //
  // The gateway URL falls back to the catalog one because today both services live behind the
  // same gateway; it is separate so that they can be moved apart without a code change.
  SHOPPER_TRYON_GATEWAY_URL: z.string().url().optional(),
  SHOPPER_TRYON_API_KEY: z.string().optional(),

  // Where a scanned QR code sends the shopper. The product code is appended to it.
  //
  // Env rather than hardcoded because the QR is PRINTED: a tag on a garment outlives any
  // deploy, so the destination has to be changeable without reprinting every label.
  SHOPPER_TRYON_APP_URL: z.string().url().optional(),

  // Origins a scan link may carry a shopper back to, comma separated.
  //
  // The try-on page shows a Back control, and for someone who arrived from one of our pages
  // that has to return them to OUR page rather than into the try-on vendor's own storefront.
  // The way back travels in the link as ?returnUrl=.
  //
  // An allow-list rather than "whatever the caller passes", because these links get PRINTED
  // and mailed. A returnUrl accepted unchecked would make every product QR a redirector to
  // anywhere, with our domain on the front of it -- and unlike a bug in a page, a bad tag on
  // a garment cannot be rolled back.
  //
  // Defaults to FRONTEND_URL's origin, which is the common case: the shopper came from our
  // own front end. Set explicitly when a storefront lives somewhere else too.
  SHOPPER_TRYON_RETURN_ORIGINS: z.string().optional(),

  // --- previously unvalidated, read directly via process.env elsewhere ---------------

  // AES-256-GCM key for the reversible credential store (see lib/credentialEncryption.ts).
  // Exactly 32 bytes as 64 hex characters -- validated here so a truncated or non-hex
  // value is caught at boot rather than by a throw mid-onboarding.
  CREDENTIAL_ENCRYPTION_KEY: optionalStr(z.string()
    .regex(/^[0-9a-fA-F]{64}$/, "CREDENTIAL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)")),

  // Image upload (lib/supabase.ts). It falls back to '' when unset, so uploads fail at
  // use-time rather than at boot.
  SUPABASE_URL: optionalStr(z.string().url("SUPABASE_URL must be a valid URL")),
  SUPABASE_SERVICE_ROLE_KEY: optionalStr(z.string().min(1)),
  SUPABASE_ANON_KEY: optionalStr(z.string().min(1)),

  // Optional by design -- both fail SAFE when unset (the service-key branch cannot match,
  // and the admin-secret endpoint refuses everything), so they are validated for shape
  // only rather than required.
  INTERNAL_SERVICE_KEY: optionalStr(z.string().min(16, "INTERNAL_SERVICE_KEY should be at least 16 characters")),
  ADMIN_SECRET: optionalStr(z.string().min(16, "ADMIN_SECRET should be at least 16 characters")),

  // Signs outbound storefront webhooks. Deliberately NOT INTERNAL_SERVICE_KEY: that secret
  // also authenticates inbound internal calls, and the previous implementation sent it to
  // every merchant as a header -- handing each of them the key that guards internal traffic.
  //
  // Optional, and fails safe when unset: deliveries are requeued with a delay and the reason
  // is written to the delivery log the merchant can see, rather than being sent unsigned or
  // silently dropped. The feature simply does not deliver until it is configured.
  STOREFRONT_SIGNING_SECRET: optionalStr(z.string().min(32, "STOREFRONT_SIGNING_SECRET should be at least 32 characters")),

  // --- Email -------------------------------------------------------------------------
  //
  // Optional, and the app is fully usable without it: every send reports whether it went, and
  // the credential screens keep their existing "share by WhatsApp / copy" fallback. Email is an
  // improvement on that, not a dependency of it -- an SMTP outage must not stop a shop adding
  // a staff member.
  EMAIL_HOST: optionalStr(z.string().min(1)),
  EMAIL_PORT: z.preprocess(
    v => (v === undefined || v === '' ? 587 : parseInt(String(v), 10)),
    z.number().int().min(1).max(65535).default(587)
  ),
  EMAIL_HOST_USER: optionalStr(z.string().min(1)),
  EMAIL_HOST_PASSWORD: optionalStr(z.string().min(1)),
  // Gmail and most providers on 587 use STARTTLS, which is `secure: false` plus an upgrade --
  // NOT `secure: true`. Setting secure on 587 produces a connection that hangs until timeout,
  // which reads like a firewall problem rather than a configuration one. Port 465 is the
  // implicit-TLS one. This flag means "use TLS at all", and the port decides which kind.
  EMAIL_USE_TLS: z.preprocess(
    v => (v === undefined || v === '' ? true : String(v).toLowerCase() === 'true'),
    z.boolean().default(true)
  ),
  // What recipients see in the From line. Falls back to EMAIL_HOST_USER.
  EMAIL_FROM_NAME: z.string().default('Scaleezy Inventory'),
  EMAIL_FROM_ADDRESS: optionalStr(z.string().email("EMAIL_FROM_ADDRESS must be a valid address")),

  // --- Shopify -----------------------------------------------------------------------
  //
  // All optional, and the integration fails SAFE without them: the OAuth routes refuse to
  // start an install and say why, rather than redirecting a merchant to Shopify with an empty
  // client_id and letting them meet an error on Shopify's own domain.
  SHOPIFY_API_KEY: optionalStr(z.string().min(1)),
  SHOPIFY_API_SECRET: optionalStr(z.string().min(1)),

  // The public origin Shopify redirects back to, e.g. https://shopify.scaleezy.com. It must
  // match the redirect URL registered in the Shopify app EXACTLY -- Shopify compares strings,
  // not hosts. No trailing slash.
  //
  // This is env rather than derived from the request because the redirect_uri is part of the
  // OAuth signature: taking it from the Host header would let anyone who can spoof that header
  // choose where the authorization code is delivered.
  SHOPIFY_APP_URL: optionalStr(z.string().url("SHOPIFY_APP_URL must be a valid https URL")),

  // Shopify retires API versions on a fixed quarterly schedule, so this is pinned and dated
  // rather than "latest" -- an integration that silently follows the newest version breaks on
  // Shopify's timetable instead of ours.
  SHOPIFY_API_VERSION: z.string().default('2026-07'),

  // Requested at install. A merchant can grant fewer, so what was actually granted is stored
  // per installation and checked before any operation that needs one.
  SHOPIFY_SCOPES: z.string().default(
    'read_products,write_products,read_inventory,write_inventory,read_locations,read_publications,write_publications'
  ),

  // Submissions allowed per address per hour on the PUBLIC signup form. Deliberately low:
  // that endpoint is unauthenticated and each row costs a human's attention rather than
  // CPU. Configurable because a low ceiling is right for production but makes the endpoint
  // untestable end to end -- a suite that checks the validation rules exhausts the quota
  // before it ever reaches a valid submission. The default is the production value, so
  // omitting it stays safe.
  SIGNUP_RATE_LIMIT_MAX: z.preprocess(
    v => (v === undefined || v === '' ? 5 : parseInt(String(v), 10)),
    z.number().int().min(1, "SIGNUP_RATE_LIMIT_MAX must be at least 1").default(5)
  ),

  // The webhook dispatcher polls every 30s and falls back to a localhost URL, which in
  // production means it retries against localhost forever. Shape-checked here; the
  // production check below makes the omission explicit.
  STOREFRONT_WEBHOOK_URL: optionalStr(z.string().url("STOREFRONT_WEBHOOK_URL must be a valid URL")),
});

const _env = envSchema.superRefine((val, ctx) => {
  const require = (field: keyof typeof val, why: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: why, path: [field as string] });
  };

  if (val.AUTH_MODE === 'gateway' && !val.GATEWAY_PUBLIC_KEY_PATH) {
    require('GATEWAY_PUBLIC_KEY_PATH', "required when AUTH_MODE is gateway");
  }

  // Production-only requirements. Everything below boots fine without these in dev; in
  // production each one is a feature that would otherwise break in front of a user.
  if (!isProd) return;

  // 'super_secret_jwt_key_v1' was a hardcoded fallback in auth.service.ts and is committed
  // to this repository. Anyone able to read the source could forge a session token for any
  // user in any tenant, so it must never reach production -- and a short secret is barely
  // better. Refuse both rather than start and hope.
  const PUBLISHED_DEV_SECRET = 'super_secret_jwt_key_v1';
  if (val.JWT_SECRET === PUBLISHED_DEV_SECRET) {
    require('JWT_SECRET',
      "this is the development default committed to the repository -- anyone who can read the source could forge a token for any user. Generate a new one: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"");
  } else if (val.JWT_SECRET.length < 32) {
    require('JWT_SECRET',
      `must be at least 32 characters in production (currently ${val.JWT_SECRET.length})`);
  }

  if (!val.CREDENTIAL_ENCRYPTION_KEY) {
    require('CREDENTIAL_ENCRYPTION_KEY',
      "required in production -- client onboarding and Team & Users password viewing throw without it");
  }

  if (val.FRONTEND_URL.includes('localhost')) {
    require('FRONTEND_URL',
      "must be the deployed frontend origin in production -- the localhost default makes CORS reject every browser request");
  }

  if (!val.SUPABASE_URL || !(val.SUPABASE_SERVICE_ROLE_KEY || val.SUPABASE_ANON_KEY)) {
    require('SUPABASE_URL',
      "SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) are required in production -- product image upload silently fails without them");
  }

  if (!val.DIRECT_URL) {
    require('DIRECT_URL',
      "required in production -- prisma/schema.prisma declares directUrl, and migrations fail without it");
  }

  // Not fatal: the dispatcher simply has nowhere useful to post. Surfaced so it is a
  // decision rather than an accident.
  if (!val.STOREFRONT_WEBHOOK_URL) {
    console.warn(
      "[env] STOREFRONT_WEBHOOK_URL is not set. Inventory changes will not be pushed to a " +
      "storefront; the dispatcher stays idle rather than posting to a made-up target. Set " +
      "it if a storefront should be notified."
    );
  }
}).safeParse(process.env);

if (!_env.success) {
  console.error("\n❌ Invalid environment configuration -- refusing to start.\n");
  for (const issue of _env.error.issues) {
    console.error(`   • ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error(
    "\n   These are checked at boot on purpose: a missing key here would otherwise\n" +
    "   surface as a 500 during a user's first onboarding, login or upload.\n"
  );
  process.exit(1);
}

export const env = _env.data;
