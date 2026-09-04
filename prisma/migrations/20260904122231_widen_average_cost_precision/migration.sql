-- Weighted average cost is derived (total value / total units) and inventoryValue is then
-- computed from it, so rounding the average to 2 decimal places pushed the error into the
-- stored value: 8 units at 0 plus 10 received at 1200 gives 12000/18 = 666.666..., which
-- became 666.67 and reported the holding as 12000.06 for stock that cost exactly 12000.00.
-- Widening is lossless; existing values keep their current magnitude.
ALTER TABLE "inventory_product_variants" ALTER COLUMN "average_cost" SET DATA TYPE DECIMAL(18,6);
