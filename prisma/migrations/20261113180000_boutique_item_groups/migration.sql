-- Everything a boutique stocks, not only cloth (13 Nov 2026, PLAN-boutique-sync.md): what group the boutique files an
-- item under (FABRIC, BORDER, LINING, EMBELLISHMENT, STITCHING, PACKAGING, MAGGAM, FINISHED, OTHER) and what sort of
-- thing it is (MATERIAL, CONSUMABLE, TOOL, MACHINE, ASSET). Text, not enums (the shared-database enum hazard); empty
-- for Inventory's own products.
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "boutique_category" TEXT;
ALTER TABLE "inventory_products" ADD COLUMN IF NOT EXISTS "item_type" TEXT;
