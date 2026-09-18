import { z } from 'zod';

// Every setting is read and checked once, at start. A missing or malformed secret stops the
// service with a message naming the variable: a service that starts with a guessed secret is
// worse than one that refuses to start.

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? fallback : ['true', '1', 'yes'].includes(v)));

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be a whole number from ${min} to ${max}` });
        return z.NEVER;
      }
      return n;
    });

const secret = (minLength: number) =>
  z.string({ required_error: 'is required' }).min(minLength, `must be at least ${minLength} characters`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: int(18081, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z
    .string({ required_error: 'is required' })
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),

  // Engine address. On Render the blueprint hands over host:port only, so a missing scheme
  // means plain http on the private network.
  ENGINE_URL: z
    .string({ required_error: 'is required' })
    .min(1)
    .transform((v) => (/^https?:\/\//.test(v) ? v : `http://${v}`).replace(/\/+$/, '')),
  ENGINE_API_KEY: secret(16),
  ENGINE_WEBHOOK_SECRET: secret(24),

  ADMIN_KEY: secret(24),
  // 32 bytes, base64. Encrypts module webhook secrets at rest.
  ENCRYPTION_KEY: z
    .string({ required_error: 'is required' })
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64 encoded'),

  SCALEEZY_INSTANCE: z.string({ required_error: 'is required' }).regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, - and _ only'),
  SCALEEZY_DAILY_CAP: int(150, 1, 10000),

  WORKER_ENABLED: bool(true),
  SEND_GAP_MIN_MS: int(4000, 0, 600000),
  SEND_GAP_MAX_MS: int(9000, 0, 600000),
  WORKER_TICK_MS: int(1000, 50, 60000),
  HEALTH_WATCH_INTERVAL_MS: int(5 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),

  CANARY_ENABLED: bool(false),
  CANARY_TO: z.string().optional(),
  CANARY_HOUR_IST: int(9, 0, 23),
});

export type Config = z.infer<typeof schema> & { canaryTo: string | null };

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // On Render the engine and the service share one env group, where the engine's key has the
  // engine's own name. Accept it under that name too.
  const input = { ...env };
  if (!input.ENGINE_API_KEY && input.AUTHENTICATION_API_KEY) input.ENGINE_API_KEY = input.AUTHENTICATION_API_KEY;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new ConfigError(`The WhatsApp service cannot start: some settings are missing or wrong.\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  if (c.SEND_GAP_MAX_MS < c.SEND_GAP_MIN_MS) {
    throw new ConfigError('The WhatsApp service cannot start: SEND_GAP_MAX_MS must not be below SEND_GAP_MIN_MS.');
  }
  return { ...c, canaryTo: c.CANARY_TO?.trim() || null };
}
