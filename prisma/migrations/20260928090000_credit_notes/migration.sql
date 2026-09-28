-- A return is not a negative invoice. Under GST it is a CREDIT NOTE: its own unbroken series per
-- financial year, a reference to the bill it reverses, and the tax taken back at the rate the
-- ORIGINAL line carried -- read from the frozen sale line, never looked up again, so a rate that
-- changed in between cannot rewrite what a customer was charged.
--
-- Additive: new nullable columns only. Null on every return taken before this, and on returns for
-- a shop that charges no tax.
ALTER TABLE "sales_returns" ADD COLUMN "credit_note_no" TEXT;
ALTER TABLE "sales_returns" ADD COLUMN "taxable_value" DECIMAL(15,2);
ALTER TABLE "sales_returns" ADD COLUMN "cgst" DECIMAL(15,2);
ALTER TABLE "sales_returns" ADD COLUMN "sgst" DECIMAL(15,2);
ALTER TABLE "sales_returns" ADD COLUMN "igst" DECIMAL(15,2);

-- Unbroken per shop. Nulls do not collide in Postgres, so returns without one are unaffected.
CREATE UNIQUE INDEX "uq_sales_return_credit_note" ON "sales_returns"("client_id", "credit_note_no");

ALTER TABLE "sales_return_items" ADD COLUMN "hsn_code" TEXT;
ALTER TABLE "sales_return_items" ADD COLUMN "tax_rate_bps" INTEGER;
ALTER TABLE "sales_return_items" ADD COLUMN "taxable_value" DECIMAL(15,2);
ALTER TABLE "sales_return_items" ADD COLUMN "cgst" DECIMAL(15,2);
ALTER TABLE "sales_return_items" ADD COLUMN "sgst" DECIMAL(15,2);
ALTER TABLE "sales_return_items" ADD COLUMN "igst" DECIMAL(15,2);
