-- 28 Oct 2026. A shopper hearting a try-on in TryOn2Buy's list (proved WhatsApp number only), shown on
-- the Customer card. New nullable column only: no enum, no change to an existing column.
ALTER TABLE "shop_product_views" ADD COLUMN IF NOT EXISTS "liked_at" TIMESTAMP(3);
