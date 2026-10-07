-- The buyer as issued on a B2B tax invoice from the till, frozen on the order. Add-only: three
-- nullable text columns, no enum, nothing existing touched. Empty on every B2C bill.
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "buyer_name" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "buyer_gstin" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "buyer_address" TEXT;
