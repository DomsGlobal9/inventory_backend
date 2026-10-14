-- Customers taken out of a group by hand: its spending rule never re-adds them. Additive.
ALTER TABLE "customer_groups" ADD COLUMN "auto_excluded" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
