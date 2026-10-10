-- A service product (fall & pico, stitching): no stock is kept for it. Add-only, defaults false.
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "is_service" BOOLEAN NOT NULL DEFAULT false;
