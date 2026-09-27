-- The GST columns move from BIGINT paise to DECIMAL rupees.
--
-- BIGINT was right for the arithmetic and wrong for the resting place. Prisma hands a BigInt back
-- on every read, and order items are returned raw from a dozen endpoints -- so JSON.stringify
-- threw "Do not know how to serialize a BigInt" on all of them. The counter-sale suite caught it
-- on the first run after the change, which is the whole reason that suite exists.
--
-- DECIMAL(15,2) is what every other money column on sales_order_items already uses --
-- list_unit_price, unit_price, total_price -- so this is the table's own convention rather than a
-- new one. The sums are still done in whole paise by the pure engine; only where they rest
-- changed. The names lose "_minor" because they no longer hold minor units.
--
-- Safe to do as a drop and re-add: these columns were added hours ago by 20260927120000_gst and
-- nothing has been written to them. No order carries tax yet.

ALTER TABLE "sales_order_items"
  DROP COLUMN IF EXISTS "taxable_value_minor",
  DROP COLUMN IF EXISTS "cgst_minor",
  DROP COLUMN IF EXISTS "sgst_minor",
  DROP COLUMN IF EXISTS "igst_minor";

ALTER TABLE "sales_order_items"
  ADD COLUMN IF NOT EXISTS "taxable_value" DECIMAL(15, 2),
  ADD COLUMN IF NOT EXISTS "cgst"          DECIMAL(15, 2),
  ADD COLUMN IF NOT EXISTS "sgst"          DECIMAL(15, 2),
  ADD COLUMN IF NOT EXISTS "igst"          DECIMAL(15, 2);

ALTER TABLE "sales_orders"
  DROP COLUMN IF EXISTS "round_off_minor";

ALTER TABLE "sales_orders"
  ADD COLUMN IF NOT EXISTS "round_off" DECIMAL(10, 2) NOT NULL DEFAULT 0;
