-- Import customers from the Customers screen (17 Nov 2026). An import from the screen is one more load in the same
-- table as the script's loads, so it is taken back out by the same rule. Only new, empty columns: nothing changes for
-- a load already there, and a running server that does not know them yet never reads them.
ALTER TABLE "past_purchase_imports" ADD COLUMN IF NOT EXISTS "kind" TEXT;
ALTER TABLE "past_purchase_imports" ADD COLUMN IF NOT EXISTS "file_name" TEXT;
ALTER TABLE "past_purchase_imports" ADD COLUMN IF NOT EXISTS "made_by" TEXT;
ALTER TABLE "past_purchase_imports" ADD COLUMN IF NOT EXISTS "made_by_name" TEXT;
CREATE INDEX IF NOT EXISTS "past_purchase_imports_client_id_kind_idx" ON "past_purchase_imports" ("client_id", "kind");
