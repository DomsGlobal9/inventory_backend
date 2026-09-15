-- Which store a purchase order is for, and the address a supplier delivers to.
--
-- A purchase order recorded no store at all. It was raised because one store was short, but
-- receiving put the goods wherever the person picked, without a word -- and the supplier's PDF,
-- email and WhatsApp never said where to deliver.
--
--   purchase_orders.location_id      the store the order is for (the supplier delivers there)
--   inventory_locations.address      where that store is, printed as the delivery address
--   inventory_locations.phone        who to call at that store on delivery
--
-- SET NULL, not RESTRICT: the store delete refuses while open orders still point at it (see
-- location.controller.ts), so only finished orders can lose the link, and losing it must not
-- stop a store that no longer exists from being removed.
ALTER TABLE "purchase_orders" ADD COLUMN "location_id" TEXT;
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "purchase_orders_client_id_location_id_idx" ON "purchase_orders"("client_id", "location_id");

ALTER TABLE "inventory_locations" ADD COLUMN "address" TEXT;
ALTER TABLE "inventory_locations" ADD COLUMN "phone" TEXT;

-- Existing orders, filled in only where the answer is known rather than guessed:
--   1. an order that has received goods is for the store its first delivery went into;
--   2. an order in a shop with exactly one active store is for that store.
-- Anything else stays empty, and the order page asks for it.
UPDATE "purchase_orders" po
SET "location_id" = first_receipt."location_id"
FROM (
  SELECT DISTINCT ON ("po_id") "po_id", "location_id"
  FROM "purchase_receipts"
  ORDER BY "po_id", "received_at" ASC
) first_receipt
WHERE first_receipt."po_id" = po."id" AND po."location_id" IS NULL;

UPDATE "purchase_orders" po
SET "location_id" = only_store."id"
FROM (
  SELECT "client_id", MIN("id") AS "id"
  FROM "inventory_locations"
  WHERE "active" = true
  GROUP BY "client_id"
  HAVING COUNT(*) = 1
) only_store
WHERE only_store."client_id" = po."client_id" AND po."location_id" IS NULL;
