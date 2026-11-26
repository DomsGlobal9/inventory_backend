-- Several photos of one saree (sareeExtras) and product-photos-only jobs (26 Nov 2026). Empty for every existing job.
ALTER TABLE "photo_jobs" ADD COLUMN IF NOT EXISTS "extra_source_image_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "photo_jobs" ADD COLUMN IF NOT EXISTS "extra_source_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "photo_jobs" ADD COLUMN IF NOT EXISTS "front_view_url" TEXT;
