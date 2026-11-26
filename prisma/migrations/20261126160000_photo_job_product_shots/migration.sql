-- Catalog product shots (26 Nov 2026): a saree's three-view job may also ask for the 3 product photos with no model.
-- Off for every existing job, so nothing already queued changes.
ALTER TABLE "photo_jobs" ADD COLUMN IF NOT EXISTS "product_shots" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "photo_jobs" ADD COLUMN IF NOT EXISTS "shots_done" INTEGER NOT NULL DEFAULT 0;
