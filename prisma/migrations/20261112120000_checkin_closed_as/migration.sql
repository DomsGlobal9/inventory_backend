-- How a door arrival ended (12 Nov 2026): DONE (served), BILLED (a bill finished it), LEFT ("Not here":
-- they left or nobody came), MISTAKE (closed as a wrong scan). Who closed it, for the timeline. Nullable
-- plain columns, so a build that does not know them keeps working.
ALTER TABLE "store_checkins" ADD COLUMN IF NOT EXISTS "closed_as" TEXT;
ALTER TABLE "store_checkins" ADD COLUMN IF NOT EXISTS "closed_by_id" TEXT;
ALTER TABLE "store_checkins" ADD COLUMN IF NOT EXISTS "closed_by_name" TEXT;
