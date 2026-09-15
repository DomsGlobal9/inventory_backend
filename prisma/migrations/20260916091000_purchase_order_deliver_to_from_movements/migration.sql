-- The store for orders received before goods receipts existed (15 Sep 2026).
--
-- The previous migration filled the store in from an order's first goods receipt, but most
-- part-received orders were received before receipts were written, so they have none. Their stock
-- movements still say where the goods went: each delivery wrote a PURCHASE_RECEIPT movement with
-- reference PO and the order number. The earliest one is the store the order was received into.
UPDATE "purchase_orders" po
SET "location_id" = first_movement."location_id"
FROM (
  SELECT DISTINCT ON (t."client_id", t."reference_id") t."client_id", t."reference_id", t."location_id"
  FROM "inventory_transactions" t
  WHERE t."reason" = 'PURCHASE_RECEIPT' AND t."reference_type" = 'PO' AND t."reference_id" IS NOT NULL
  ORDER BY t."client_id", t."reference_id", t."created_at" ASC
) first_movement
JOIN "inventory_locations" l ON l."id" = first_movement."location_id" AND l."client_id" = first_movement."client_id"
WHERE first_movement."client_id" = po."client_id"
  AND first_movement."reference_id" = po."po_number"
  AND po."location_id" IS NULL;
