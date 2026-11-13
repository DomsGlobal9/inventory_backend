-- Fabrics by the metre (13 Nov 2026, PLAN-fabrics.md). Additive only: every existing product stays PIECE and every
-- shop stays off, so the deployed build reading this shared database is unaffected.
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "sold_by" TEXT NOT NULL DEFAULT 'PIECE';
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "kind" TEXT;
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "min_cut" INTEGER;
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "width_cm" INTEGER;
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "roll_size" INTEGER;

ALTER TABLE "client_settings" ADD COLUMN IF NOT EXISTS "fabrics_on" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "client_settings" ADD COLUMN IF NOT EXISTS "fabric_min_cut" INTEGER NOT NULL DEFAULT 25;
ALTER TABLE "client_settings" ADD COLUMN IF NOT EXISTS "fabric_roll_size" INTEGER NOT NULL DEFAULT 2500;

-- Guard rails the app also checks: a known unit, a positive smallest cut / width / roll.
ALTER TABLE "inventory_products" DROP CONSTRAINT IF EXISTS "inventory_products_sold_by_known";
ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_sold_by_known"
  CHECK ("sold_by" IN ('PIECE', 'METRE', 'PACKET', 'PAIR', 'SET', 'KILOGRAM', 'GRAM', 'BOX', 'STRING', 'UNIT'));
ALTER TABLE "inventory_products" DROP CONSTRAINT IF EXISTS "inventory_products_unit_sizes_positive";
ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_unit_sizes_positive"
  CHECK (("min_cut" IS NULL OR "min_cut" > 0) AND ("width_cm" IS NULL OR "width_cm" > 0) AND ("roll_size" IS NULL OR "roll_size" > 0));
