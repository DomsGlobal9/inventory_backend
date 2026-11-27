-- Boutique items can be changed in ScaleEzy too (27 Nov 2026, owner: "in ours also can able to change").
-- Every change the shop makes on ScaleEzy's own screens to an item the boutique app knows is noted here, and the
-- boutique app reads them (GET /internal/boutique/items/changed) to keep its own copy the same.
CREATE TABLE IF NOT EXISTS "boutique_shop_edits" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "item_code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fields" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "boutique_shop_edits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "boutique_shop_edits_client_id_created_at_id_idx" ON "boutique_shop_edits"("client_id", "created_at", "id");

-- A shop handed to the boutique app ("the boutique app runs the whole shop"): products the shop adds later in ScaleEzy
-- reach the boutique app too.
ALTER TABLE "boutique_links" ADD COLUMN IF NOT EXISTS "handed_over_at" TIMESTAMP(3);
-- Shops handed over before this column existed: the hand-over is the only thing that gives a product the shop made
-- itself (no "boutique:" import key) the boutique as its price owner.
UPDATE "boutique_links" l SET "handed_over_at" = l."linked_at"
WHERE l."unlinked_at" IS NULL AND l."handed_over_at" IS NULL AND EXISTS (
    SELECT 1 FROM "inventory_products" p
    WHERE p."client_id" = l."client_id" AND p."price_owner" = 'BOUTIQUE'
      AND (p."import_key" IS NULL OR p."import_key" NOT LIKE 'boutique:%')
);
