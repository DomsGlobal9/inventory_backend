-- Catalog try-on usage split into four-view catalogs and colour variants (owner, 28 Oct).
-- New columns only, each NOT NULL DEFAULT 0: existing rows read 0 (their colour runs stay in the
-- totals, as before), and a build that does not know these columns keeps writing rows that
-- default them. No enum values, no change to any existing column.
ALTER TABLE "tryon_usage" ADD COLUMN IF NOT EXISTS "colour_started" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tryon_usage" ADD COLUMN IF NOT EXISTS "colour_completed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tryon_usage" ADD COLUMN IF NOT EXISTS "colour_failed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tryon_usage" ADD COLUMN IF NOT EXISTS "colour_cancelled" INTEGER NOT NULL DEFAULT 0;
