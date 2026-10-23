-- Kept orders from the till: the promised collection date and when the goods were handed over.
-- Two nullable columns only: builds already deployed never name them, so they are unaffected.
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "promised_at" TIMESTAMP(3);
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "handed_over_at" TIMESTAMP(3);
