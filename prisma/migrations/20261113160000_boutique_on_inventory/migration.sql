-- The boutique (CRM-B) uses ScaleEzy Inventory for its products and stock (13 Nov 2026, PLAN-boutique-sync.md
-- section 0). Additive only: every existing product stays sellable and owned by Inventory.

-- A product the shop does not sell (threads, needles, beads): a material, counted and used, never in the online
-- shop, the till, Shopify, other websites or offers.
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "sell_in_shop" BOOLEAN NOT NULL DEFAULT true;
-- Who sets the price: 'INVENTORY' (today) or 'BOUTIQUE' (an item the boutique created; read-only in Inventory).
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "price_owner" TEXT NOT NULL DEFAULT 'INVENTORY';
ALTER TABLE "inventory_products" DROP CONSTRAINT IF EXISTS "inventory_products_price_owner_known";
ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_price_owner_known" CHECK ("price_owner" IN ('INVENTORY', 'BOUTIQUE'));
-- The boutique's own item code on the colour it created (unique per shop), so a repeated or replayed item lands once.
ALTER TABLE "inventory_product_variants" ADD COLUMN IF NOT EXISTS "boutique_ref" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_product_variants_client_boutique_ref_key"
  ON "inventory_product_variants" ("client_id", "boutique_ref") WHERE "boutique_ref" IS NOT NULL;
-- What the boutique called a movement (RESERVE, ISSUE, CONSUME, RETURN_UNUSED, WASTE, DAMAGE, SCRAP...), with its
-- order reference and the person, beside our own reason (text, not an enum: the shared-database enum hazard).
ALTER TABLE "inventory_transactions" ADD COLUMN IF NOT EXISTS "boutique_kind" TEXT;
ALTER TABLE "inventory_transactions" ADD COLUMN IF NOT EXISTS "boutique_order_ref" TEXT;
ALTER TABLE "inventory_transactions" ADD COLUMN IF NOT EXISTS "actor_name" TEXT;

-- A linked boutique: which boutique account (tenant) is which ScaleEzy shop.
CREATE TABLE IF NOT EXISTS "boutique_links" (
  "client_id"   TEXT PRIMARY KEY,
  "tenant"      TEXT NOT NULL,
  "shop_name"   TEXT,
  "linked_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unlinked_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "boutique_links_tenant_key" ON "boutique_links" ("tenant");

-- Every write from the boutique carries a request id; the first answer is kept and given again for a repeat, so a
-- retry over a bad network never cuts cloth twice.
CREATE TABLE IF NOT EXISTS "boutique_requests" (
  "client_id"  TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "status"     INTEGER NOT NULL,
  "answer"     JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("client_id", "request_id")
);
CREATE INDEX IF NOT EXISTS "boutique_requests_created_at_idx" ON "boutique_requests" ("created_at");

-- Cloth held for a boutique stitching order. Counted in inventory_stocks.reserved_qty like an order's
-- reservation, so the online shop and the till cannot sell it.
CREATE TABLE IF NOT EXISTS "boutique_reservations" (
  "id"          TEXT PRIMARY KEY,
  "client_id"   TEXT NOT NULL,
  "variant_id"  TEXT NOT NULL REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE,
  "location_id" TEXT NOT NULL REFERENCES "inventory_locations"("id") ON DELETE RESTRICT,
  "order_ref"   TEXT NOT NULL,
  "quantity"    INTEGER NOT NULL CHECK ("quantity" > 0),
  "status"      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'RELEASED', 'ISSUED')),
  "actor_name"  TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "boutique_reservations_client_order_idx" ON "boutique_reservations" ("client_id", "order_ref");
CREATE INDEX IF NOT EXISTS "boutique_reservations_variant_idx" ON "boutique_reservations" ("variant_id");
