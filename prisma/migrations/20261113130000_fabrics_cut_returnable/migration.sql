-- Cut cloth is not taken back unless the owner allows it per product (13 Nov 2026, PLAN-fabrics decision 3).
-- Additive; only read for metre/kilogram products, so every existing product behaves as before.
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "cut_returnable" BOOLEAN NOT NULL DEFAULT false;
