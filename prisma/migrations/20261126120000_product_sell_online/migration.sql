-- Sell online on/off per product (PLAN-sell-online.md). On for every existing product: nothing changes until a shop
-- switches one off. The catalogue_stamp_product trigger stamps catalogue_changed_at on the update, so a website's
-- quick pull sees the product leave.
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "sell_online" BOOLEAN NOT NULL DEFAULT true;
