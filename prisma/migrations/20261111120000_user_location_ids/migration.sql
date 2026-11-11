-- Which stores a team member works in (11 Nov 2026): stock_locations ids of this shop. Empty = all stores.
-- Read by ScaleEzy CRM from the session answer (user.locationIds) to limit its Sales dashboard and At the
-- door. A plain column with a default, so a build that does not know it keeps working.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "location_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
