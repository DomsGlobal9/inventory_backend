-- Boutique (CRM-B) items can be DELETED, not only archived (17 Nov 2026).
--
-- An item that was never used is erased outright. One with a past (stock movements, bills, purchase orders) cannot
-- be: its records must keep adding up. That one is kept, out of sight -- this column says when the boutique deleted
-- it. Its boutique_ref / sku / variant_code get a "#..." tail at the same time, so the boutique's code is free for a
-- new item, and every lookup by code misses the old one without being told to.
--
-- Additive and nullable: the build running before this one never reads it.
ALTER TABLE "inventory_product_variants" ADD COLUMN IF NOT EXISTS "boutique_deleted_at" TIMESTAMP(3);

-- Lists of the boutique's items leave deleted ones out; few rows ever carry a date, so this stays tiny.
CREATE INDEX IF NOT EXISTS "inventory_product_variants_boutique_deleted_idx"
  ON "inventory_product_variants" ("client_id") WHERE "boutique_deleted_at" IS NOT NULL;
