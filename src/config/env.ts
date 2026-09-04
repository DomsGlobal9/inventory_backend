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

  CATALOG_TRYON_GATEWAY_URL: z.string().url().optional(),
  CATALOG_TRYON_API_KEY: z.string().optional(),

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
