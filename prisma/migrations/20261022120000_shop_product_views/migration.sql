-- What a shopper who proved their number looked at and tried on in the online shop (Customer card).
-- A new table only: nothing existing is read or changed, so builds already deployed are unaffected.
CREATE TABLE IF NOT EXISTS "shop_product_views" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "try_ons" INTEGER NOT NULL DEFAULT 0,
    "variant_id" TEXT,
    "first_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_product_views_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "shop_product_views_client_id_phone_idx" ON "shop_product_views"("client_id", "phone");

CREATE INDEX IF NOT EXISTS "shop_product_views_last_at_idx" ON "shop_product_views"("last_at");

CREATE UNIQUE INDEX IF NOT EXISTS "shop_product_views_client_id_phone_product_id_key" ON "shop_product_views"("client_id", "phone", "product_id");

DO $$ BEGIN
  ALTER TABLE "shop_product_views" ADD CONSTRAINT "shop_product_views_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
