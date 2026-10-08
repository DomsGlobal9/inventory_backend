-- Udhaar the shop gave up on (the till's write-off). Add-only: one money column defaulting to 0 and
-- three nullable ones, no enum, nothing existing touched -- the deployed build keeps reading orders.
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "written_off" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "written_off_reason" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "written_off_by" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "written_off_at" TIMESTAMP(3);
