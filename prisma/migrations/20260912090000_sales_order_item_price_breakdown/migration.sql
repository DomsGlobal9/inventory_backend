-- Per-line price breakdown on sales order items.
--
-- Until now a line held one price, and `createFullOrder` always filled it from our own
-- catalogue -- discarding whatever the selling system said it had actually charged. Every
-- discounted sale was therefore recorded at full price, and grossProfit, the day book's revenue
-- and dispatch valuation were all overstated by the discount.
--
-- Four columns, added in the order a migration has to do it: nullable with a default, backfilled
-- from what is already there, then tightened. Doing it in one step would either fail on the
-- existing rows or leave a column whose default silently prices historical orders at zero.

-- 1. Gross price per unit, before anything is taken off.
ALTER TABLE "sales_order_items" ADD COLUMN "list_unit_price" DECIMAL(10,2);

-- Every existing row was created by the old code, which charged the catalogue price and applied
-- no line discount. Its unit price IS its list price, so nothing historical changes value.
UPDATE "sales_order_items" SET "list_unit_price" = "unit_price" WHERE "list_unit_price" IS NULL;

ALTER TABLE "sales_order_items" ALTER COLUMN "list_unit_price" SET NOT NULL;

-- 2. Discount belonging to this line itself.
ALTER TABLE "sales_order_items"
  ADD COLUMN "line_discount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- 3. This line's share of a discount typed against the whole order.
--
-- Deliberately NOT backfilled from sales_orders.discount_amount. That figure was never divided
-- between lines, and inventing a split now would rewrite the recorded margin of orders that have
-- already been reported on and, in some cases, already paid commission against. Historical
-- orders keep the profit figure they have always had; the fix applies from here forward.
ALTER TABLE "sales_order_items"
  ADD COLUMN "allocated_discount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- 4. Who decided the price. Existing rows were all resolved from the catalogue by definition.
ALTER TABLE "sales_order_items"
  ADD COLUMN "price_source" TEXT NOT NULL DEFAULT 'CATALOGUE';
