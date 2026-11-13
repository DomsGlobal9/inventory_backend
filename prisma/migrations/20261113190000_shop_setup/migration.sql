-- What the shop sells, asked at onboarding and confirmed by the owner at first sign-in (PLAN-onboarding-setup.md).
-- READY_MADE keeps everything by the metre out of sight; FABRICS and BOTH switch it on. NULL = not asked yet.
ALTER TABLE "client_settings" ADD COLUMN IF NOT EXISTS "sells" TEXT;
ALTER TABLE "client_settings" DROP CONSTRAINT IF EXISTS "client_settings_sells_known";
ALTER TABLE "client_settings" ADD CONSTRAINT "client_settings_sells_known" CHECK ("sells" IS NULL OR "sells" IN ('READY_MADE', 'FABRICS', 'BOTH'));
-- When the owner finished "Set up your shop". NULL = not yet, so the owner is shown it once (shops from before this too).
ALTER TABLE "client_settings" ADD COLUMN IF NOT EXISTS "setup_done_at" TIMESTAMP(3);
