import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('4006'),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
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
});

const _env = envSchema.superRefine((val, ctx) => {
  if (val.AUTH_MODE === 'gateway' && !val.GATEWAY_PUBLIC_KEY_PATH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "GATEWAY_PUBLIC_KEY_PATH is required when AUTH_MODE is gateway",
      path: ["GATEWAY_PUBLIC_KEY_PATH"]
    });
  }
}).safeParse(process.env);

if (!_env.success) {
  console.error("❌ Invalid environment variables:");
  console.error(_env.error.format());
  process.exit(1);
}

export const env = _env.data;
