-- A photo job the studio asked to come back later (busy, or a daily / short-burst limit): not started before this.
ALTER TABLE "photo_jobs" ADD COLUMN IF NOT EXISTS "not_before" TIMESTAMP(3);
