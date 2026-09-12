-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('WOMEN', 'MEN', 'KIDS', 'UNISEX');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('READY_TO_WEAR', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED', 'OUT_OF_STOCK');

-- CreateEnum
CREATE TYPE "ProductImageType" AS ENUM ('COVER', 'GALLERY', 'RAW_UPLOAD');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "inventory_products" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "ProductCategory" NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "dress_type" TEXT,
    "fabric" TEXT,
    "craft" TEXT,
    "brand" TEXT,
    "base_price" DECIMAL(10,2) NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_product_variants" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "size" TEXT,
    "color_name" TEXT,
    "hex_code" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reorder_level" INTEGER NOT NULL DEFAULT 5,
    "price_override" DECIMAL(10,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_product_images" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "image_type" "ProductImageType" NOT NULL,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_products_client_id_title_idx" ON "inventory_products"("client_id", "title");

-- CreateIndex
CREATE INDEX "inventory_products_client_id_status_idx" ON "inventory_products"("client_id", "status");

-- CreateIndex
CREATE INDEX "inventory_products_client_id_category_idx" ON "inventory_products"("client_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_products_client_id_product_code_key" ON "inventory_products"("client_id", "product_code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_products_client_id_slug_key" ON "inventory_products"("client_id", "slug");

-- CreateIndex
CREATE INDEX "inventory_product_variants_product_id_idx" ON "inventory_product_variants"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_variants_client_id_sku_key" ON "inventory_product_variants"("client_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_variants_product_id_size_color_name_key" ON "inventory_product_variants"("product_id", "size", "color_name");

-- CreateIndex
CREATE INDEX "inventory_product_images_product_id_idx" ON "inventory_product_images"("product_id");

-- CreateIndex
CREATE INDEX "inventory_transactions_variant_id_idx" ON "inventory_transactions"("variant_id");

-- AddForeignKey
ALTER TABLE "inventory_product_variants" ADD CONSTRAINT "inventory_product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_product_images" ADD CONSTRAINT "inventory_product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
