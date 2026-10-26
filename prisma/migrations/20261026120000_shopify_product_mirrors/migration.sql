-- Our products kept as products in a connected Shopify store. Additive only: a new table.
CREATE TABLE IF NOT EXISTS "shopify_product_mirrors" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'CREATED',
    "wanted" BOOLEAN NOT NULL DEFAULT true,
    "shopify_product_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stock_pending" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "problem" TEXT,
    "last_hash" TEXT,
    "images_hash" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_product_mirrors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "shopify_product_mirrors_installation_id_product_id_key" ON "shopify_product_mirrors"("installation_id", "product_id");
CREATE INDEX IF NOT EXISTS "shopify_product_mirrors_client_id_idx" ON "shopify_product_mirrors"("client_id");
CREATE INDEX IF NOT EXISTS "shopify_product_mirrors_status_next_attempt_at_idx" ON "shopify_product_mirrors"("status", "next_attempt_at");

DO $$ BEGIN
  ALTER TABLE "shopify_product_mirrors" ADD CONSTRAINT "shopify_product_mirrors_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "shopify_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "shopify_product_mirrors" ADD CONSTRAINT "shopify_product_mirrors_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
