-- Goods receipts for purchase orders, and the details a letterhead needs.

-- 1. A receipt per delivery.
--
-- Receiving goods against a purchase order raised the line's received count and moved stock,
-- and left nothing else behind: not when the delivery came, who counted it, which shop it went
-- into, or the supplier's invoice number. Two deliveries against one order were
-- indistinguishable, so nothing could print what arrived in each -- the document a shop hands
-- back to the driver and files with the supplier's bill.
--
-- Each line records what it was measured against at the time (ordered, already received), so a
-- receipt printed a year later still says "3 of 10, 5 still to come" rather than recomputing
-- from a purchase order that has moved on since.
CREATE TABLE "purchase_receipts" (
  "id"                 TEXT NOT NULL,
  "client_id"          TEXT NOT NULL,
  "receipt_number"     TEXT NOT NULL,
  "po_id"              TEXT NOT NULL,
  "location_id"        TEXT NOT NULL,
  "received_by_id"     TEXT,
  "received_by_name"   TEXT,
  "supplier_reference" TEXT,
  "notes"              TEXT,
  -- Sent by the screen once per press of Confirm Receipt. A double click, or a retry after a
  -- slow network, carries the same key and gets the same receipt back instead of a second
  -- delivery booked into stock.
  "request_key"        TEXT,
  "received_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_purchase_receipt_number" ON "purchase_receipts"("client_id", "receipt_number");
CREATE UNIQUE INDEX "uq_purchase_receipt_request" ON "purchase_receipts"("client_id", "request_key");
CREATE INDEX "purchase_receipts_po_id_idx" ON "purchase_receipts"("po_id");
CREATE INDEX "purchase_receipts_client_id_received_at_idx" ON "purchase_receipts"("client_id", "received_at");

ALTER TABLE "purchase_receipts"
  ADD CONSTRAINT "purchase_receipts_po_id_fkey"
  FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_receipts"
  ADD CONSTRAINT "purchase_receipts_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "purchase_receipt_items" (
  "id"              TEXT NOT NULL,
  "receipt_id"      TEXT NOT NULL,
  "po_item_id"      TEXT NOT NULL,
  "variant_id"      TEXT NOT NULL,
  "sku"             TEXT NOT NULL,
  "variant_code"    TEXT,
  "product_title"   TEXT NOT NULL,
  "color"           TEXT,
  "size"            TEXT,
  "ordered_qty"     INTEGER NOT NULL,
  "received_before" INTEGER NOT NULL,
  "quantity"        INTEGER NOT NULL,
  "unit_price"      DECIMAL(65,30) NOT NULL,
  CONSTRAINT "purchase_receipt_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_receipt_items_receipt_id_idx" ON "purchase_receipt_items"("receipt_id");
CREATE INDEX "purchase_receipt_items_po_item_id_idx" ON "purchase_receipt_items"("po_item_id");

ALTER TABLE "purchase_receipt_items"
  ADD CONSTRAINT "purchase_receipt_items_receipt_id_fkey"
  FOREIGN KEY ("receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_receipt_items"
  ADD CONSTRAINT "purchase_receipt_items_po_item_id_fkey"
  FOREIGN KEY ("po_item_id") REFERENCES "purchase_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_receipt_items"
  ADD CONSTRAINT "purchase_receipt_items_variant_id_fkey"
  FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. A letterhead.
--
-- The purchase order PDF printed "ScaleEzy Boutiques Ltd., 123 Commerce Way, Warehouse District,
-- TX 75001" for every shop on the platform, because the shop's own address was stored nowhere.
-- Name and logo already live here; these are the rest of what a document sent to a supplier
-- has to say about who sent it. All optional -- a line that is empty is simply not printed.
ALTER TABLE "client_settings" ADD COLUMN "business_address" TEXT;
ALTER TABLE "client_settings" ADD COLUMN "business_phone" TEXT;
ALTER TABLE "client_settings" ADD COLUMN "business_email" TEXT;
ALTER TABLE "client_settings" ADD COLUMN "gst_number" TEXT;
