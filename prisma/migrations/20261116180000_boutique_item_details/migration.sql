-- The boutique's (CRM-B) own item details: sub-category, design group, minimum stock, rack note.
-- All optional, read and written only by the boutique API; retail shops never set them.
ALTER TABLE "inventory_products" ADD COLUMN "boutique_sub_category" TEXT;
ALTER TABLE "inventory_products" ADD COLUMN "boutique_design" TEXT;
ALTER TABLE "inventory_product_variants" ADD COLUMN "min_stock" INTEGER;
ALTER TABLE "inventory_product_variants" ADD COLUMN "rack_note" TEXT;
