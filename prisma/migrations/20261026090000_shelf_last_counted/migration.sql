-- When each shelf was last counted (Shelves > Count), so the Count screen can put the longest-uncounted first.
-- One nullable column: builds already deployed never name it, and every existing shelf is "never counted".
ALTER TABLE "storage_spots" ADD COLUMN IF NOT EXISTS "last_counted_at" TIMESTAMP(3);
