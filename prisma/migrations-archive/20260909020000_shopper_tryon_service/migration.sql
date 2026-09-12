-- Shopper Try-On: a second gateway service, with its own key and its own meter.
--
-- The existing service becomes "4-View Catalog Try-On" in the interface. Its enum member is
-- deliberately NOT renamed: the name is a label and belongs in the code, while the value is
-- written into every credential, limit and usage row already in this database. Renaming it
-- would buy a tidier enum at the price of rewriting live rows for no behavioural gain.

-- 1. The new service.
ALTER TYPE "ClientService" ADD VALUE IF NOT EXISTS 'SHOPPER_TRYON';

-- 2. Usage gains a service dimension.
--
-- Every row that exists predates shopper try-on, so CATALOG_TRYON is not a guess -- it is what
-- those rows have always meant. The default keeps that true for anything mid-flight during the
-- deploy as well.
ALTER TABLE "tryon_usage"
  ADD COLUMN IF NOT EXISTS "service" "ClientService" NOT NULL DEFAULT 'CATALOG_TRYON';

-- 3. The uniqueness has to widen with it.
--
-- This is the part that matters. On (client_id, day) alone, a shop using both try-ons would
-- collide on one row per day and the two would increment each other's counters -- not merely
-- losing the split, but silently charging one service's generations against the other. The old
-- constraint is dropped only after the new one exists, so there is no window in which two rows
-- for the same client and day could be inserted.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tryon_usage_day_service"
  ON "tryon_usage" ("client_id", "service", "day");

ALTER TABLE "tryon_usage" DROP CONSTRAINT IF EXISTS "uq_tryon_usage_day";
DROP INDEX IF EXISTS "uq_tryon_usage_day";

CREATE INDEX IF NOT EXISTS "tryon_usage_client_service_day_idx"
  ON "tryon_usage" ("client_id", "service", "day");
