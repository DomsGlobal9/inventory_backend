-- The merchant's own key for a product, carried from the file that imported it, so that
-- re-running the same file updates what it created rather than duplicating it.
-- Nullable: every existing product was created another way and has none.
ALTER TABLE "inventory_products" ADD COLUMN "import_key" TEXT;

-- Per client, not globally: two shops may both call something "kanchi-silk".
CREATE UNIQUE INDEX "inventory_products_client_id_import_key_key"
  ON "inventory_products"("client_id", "import_key");
