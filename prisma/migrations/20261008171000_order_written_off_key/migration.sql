-- The idempotencyKey of the last write-off applied to the order. Add-only, nullable.
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "written_off_key" TEXT;
