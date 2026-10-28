-- Shopify orders paid on delivery (cash on delivery), so the Orders list can show what is still to
-- collect. A new nullable column only: old orders read null, and a build that does not know it ignores it.
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "pay_on_delivery" BOOLEAN;
