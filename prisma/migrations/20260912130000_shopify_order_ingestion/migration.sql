-- Phase 1: Shopify orders into ScaleEzy.
--
-- Nothing here reads or writes Shopify. These are the places to PUT an order once it arrives,
-- and they are added before the code that fills them so that ingesting an order twice -- once
-- now without a discount breakdown and once later with one -- never becomes necessary.

-- 1. The selling system's own "last changed" stamp.
--
-- Shopify redelivers webhooks and does not promise order, so an orders/updated from two minutes
-- ago can arrive after a newer one. Comparing against this is what makes that self-correcting.
ALTER TABLE "sales_orders" ADD COLUMN "external_updated_at" TIMESTAMP(3);

-- 2. What was taken off an order, and who said so.
--
-- Deliberately the same shape as Shopify's discount_applications / discount_allocations:
-- reconciling their order against our offer is easy when both record the same thing the same
-- way, and impossible when they do not.
--
-- offer_id is nullable because a merchant can run a discount inside Shopify that we never
-- created, and that sale still has to appear in the books truthfully.
CREATE TABLE "sales_order_discounts" (
  "id"               TEXT NOT NULL,
  "sales_order_id"   TEXT NOT NULL,
  "offer_id"         TEXT,
  "offer_version_id" TEXT,
  "source"           TEXT NOT NULL,
  "external_id"      TEXT,
  "title"            TEXT NOT NULL,
  "amount"           DECIMAL(10,2) NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_order_discounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_order_discounts_sales_order_id_idx" ON "sales_order_discounts"("sales_order_id");
CREATE INDEX "sales_order_discounts_offer_id_idx" ON "sales_order_discounts"("offer_id");

ALTER TABLE "sales_order_discounts"
  ADD CONSTRAINT "sales_order_discounts_sales_order_id_fkey"
  FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- How one discount was divided between the lines it applied to. Without it a two-line order
-- carrying one code cannot say which line to refund what, and a partial return guesses.
CREATE TABLE "sales_order_item_discounts" (
  "id"                      TEXT NOT NULL,
  "sales_order_item_id"     TEXT NOT NULL,
  "sales_order_discount_id" TEXT NOT NULL,
  "amount"                  DECIMAL(10,2) NOT NULL,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_order_item_discounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_order_item_discounts_sales_order_item_id_idx" ON "sales_order_item_discounts"("sales_order_item_id");
CREATE INDEX "sales_order_item_discounts_sales_order_discount_id_idx" ON "sales_order_item_discounts"("sales_order_discount_id");

ALTER TABLE "sales_order_item_discounts"
  ADD CONSTRAINT "sales_order_item_discounts_sales_order_item_id_fkey"
  FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sales_order_item_discounts"
  ADD CONSTRAINT "sales_order_item_discounts_sales_order_discount_id_fkey"
  FOREIGN KEY ("sales_order_discount_id") REFERENCES "sales_order_discounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. A Shopify order we could not place, kept until somebody can.
--
-- Every reason is a decision a person has to make: which of our locations this shop sells from,
-- what this unrecognised SKU is. Guessing writes a real sale against the wrong shop floor;
-- dropping loses money that was actually taken. So it is parked, with the payload verbatim, and
-- replayed once the decision exists.
CREATE TABLE "shopify_order_inbox" (
  "id"               TEXT NOT NULL,
  "shop_domain"      TEXT NOT NULL,
  "client_id"        TEXT,
  "shopify_order_id" TEXT NOT NULL,
  "topic"            TEXT NOT NULL,
  "payload"          JSONB NOT NULL,
  "reason"           TEXT NOT NULL,
  "detail"           TEXT,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "resolved_at"      TIMESTAMP(3),
  "resolved_by"      TEXT,
  "sales_order_id"   TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shopify_order_inbox_pkey" PRIMARY KEY ("id")
);

-- A redelivered webhook updates its parked row instead of adding a second one.
CREATE UNIQUE INDEX "uq_inbox_order_topic"
  ON "shopify_order_inbox"("shop_domain", "shopify_order_id", "topic");
CREATE INDEX "shopify_order_inbox_client_id_resolved_at_idx" ON "shopify_order_inbox"("client_id", "resolved_at");
CREATE INDEX "shopify_order_inbox_shop_domain_created_at_idx" ON "shopify_order_inbox"("shop_domain", "created_at");

-- 4. Returns finally carry money.
--
-- A return moved stock and nothing else, so nothing could say what a refund was worth -- and
-- with a discount on the line the answer is emphatically not the list price. Refunding 12,000
-- for a saree bought at 9,600 hands back money the shop never took.
ALTER TABLE "sales_returns"
  ADD COLUMN "refund_total"       DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "refund_status"      TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "external_refund_id" TEXT;

-- The order line a return came off, directly. It was only ever reachable through DispatchItem,
-- which is fine for moving stock and no use for money. Nullable: every existing row predates
-- this and cannot be filled in reliably.
ALTER TABLE "sales_return_items"
  ADD COLUMN "sales_order_item_id" TEXT,
  ADD COLUMN "refund_amount"       DECIMAL(10,2) NOT NULL DEFAULT 0;
