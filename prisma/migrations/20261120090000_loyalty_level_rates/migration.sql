-- Customer levels (20 Nov 2026): a points rate per CRM customer group. A new column with a default only, so the
-- build already live (which does not know it) keeps reading and writing loyalty_settings unchanged.
ALTER TABLE "loyalty_settings" ADD COLUMN "level_rates" JSONB NOT NULL DEFAULT '[]';
