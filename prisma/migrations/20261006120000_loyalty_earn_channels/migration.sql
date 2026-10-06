-- Where customers earn loyalty points. Add-only, with defaults that keep every shop as it was:
-- the counter earns (as before), online shop and Shopify do not until the shop ticks them.
ALTER TABLE "loyalty_settings" ADD COLUMN IF NOT EXISTS "earn_at_counter" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "loyalty_settings" ADD COLUMN IF NOT EXISTS "earn_online_shop" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "loyalty_settings" ADD COLUMN IF NOT EXISTS "earn_shopify" BOOLEAN NOT NULL DEFAULT false;
