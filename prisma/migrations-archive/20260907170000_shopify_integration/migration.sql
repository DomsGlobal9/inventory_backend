-- CreateEnum
CREATE TYPE "ShopifyInstallSource" AS ENUM ('SCALEEZY', 'SHOPIFY');

-- CreateTable
CREATE TABLE "shopify_installations" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shopify_shop_id" TEXT,
    "client_id" TEXT,
    "source" "ShopifyInstallSource" NOT NULL DEFAULT 'SCALEEZY',
    "access_token_encrypted" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scopes" TEXT NOT NULL,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "claimed_by_user" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_id_maps" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "shopify_product_id" TEXT NOT NULL,
    "shopify_variant_id" TEXT NOT NULL,
    "shopify_inventory_item_id" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'MATCHED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_id_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_location_maps" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "shopify_location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_location_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_webhook_receipts" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3),
    "outcome" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_webhook_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_inventory_echoes" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "shopify_inventory_item_id" TEXT NOT NULL,
    "shopify_location_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "written_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_inventory_echoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shopify_installations_shop_domain_key" ON "shopify_installations"("shop_domain");

-- CreateIndex
CREATE INDEX "shopify_installations_client_id_idx" ON "shopify_installations"("client_id");

-- CreateIndex
CREATE INDEX "shopify_installations_uninstalled_at_idx" ON "shopify_installations"("uninstalled_at");

-- CreateIndex
CREATE INDEX "shopify_id_maps_client_id_idx" ON "shopify_id_maps"("client_id");

-- CreateIndex
CREATE INDEX "shopify_id_maps_installation_id_sku_idx" ON "shopify_id_maps"("installation_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_id_maps_installation_id_variant_id_key" ON "shopify_id_maps"("installation_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_id_maps_installation_id_shopify_variant_id_key" ON "shopify_id_maps"("installation_id", "shopify_variant_id");

-- CreateIndex
CREATE INDEX "shopify_location_maps_client_id_idx" ON "shopify_location_maps"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_location_maps_installation_id_location_id_key" ON "shopify_location_maps"("installation_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_location_maps_installation_id_shopify_location_id_key" ON "shopify_location_maps"("installation_id", "shopify_location_id");

-- CreateIndex
CREATE INDEX "shopify_webhook_receipts_shop_domain_created_at_idx" ON "shopify_webhook_receipts"("shop_domain", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_webhook_receipts_webhook_id_topic_key" ON "shopify_webhook_receipts"("webhook_id", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_inventory_echoes_installation_id_shopify_inventory__key" ON "shopify_inventory_echoes"("installation_id", "shopify_inventory_item_id", "shopify_location_id");

-- AddForeignKey
ALTER TABLE "shopify_id_maps" ADD CONSTRAINT "shopify_id_maps_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "shopify_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_location_maps" ADD CONSTRAINT "shopify_location_maps_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "shopify_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_inventory_echoes" ADD CONSTRAINT "shopify_inventory_echoes_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "shopify_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


