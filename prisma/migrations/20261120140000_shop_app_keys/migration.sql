-- Shop API v1 (20 Nov 2026, PLAN-shop-api.md): partner app keys, and the app an online order came from.
-- Additive only: a new table and a nullable column. No enum is touched (the shared-database rule).

CREATE TABLE "shop_app_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "switched_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    CONSTRAINT "shop_app_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shop_app_keys_key_prefix_key" ON "shop_app_keys"("key_prefix");
CREATE INDEX "shop_app_keys_tenant_idx" ON "shop_app_keys"("tenant");

ALTER TABLE "sales_orders" ADD COLUMN "origin_app" TEXT;
