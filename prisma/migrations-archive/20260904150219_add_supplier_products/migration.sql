-- CreateTable
CREATE TABLE "supplier_products" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "supplier_sku" TEXT,
    "cost_price" DECIMAL(18,6),
    "lead_time_days" INTEGER,
    "min_order_qty" INTEGER,
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_products_client_id_idx" ON "supplier_products"("client_id");

-- CreateIndex
CREATE INDEX "supplier_products_variant_id_idx" ON "supplier_products"("variant_id");

-- CreateIndex
CREATE INDEX "supplier_products_supplier_id_idx" ON "supplier_products"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_supplier_id_variant_id_key" ON "supplier_products"("supplier_id", "variant_id");

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

