-- Which garment piece a photograph IS, and the other pieces a four-view job should dress a model in.
--
-- The photos step asks for the pieces separately -- a saree and its blouse, or a full dress with
-- its top and bottom -- and then threw away which was which: every file was uploaded as GALLERY
-- with the same alt text, and the job sent exactly ONE of them. So the blouse piece, the top and
-- the bottom were collected from the shop and never reached the photo studio at all, and a shop
-- that happened to upload the blouse first had the blouse sent AS the saree. Nothing failed; the
-- pictures were simply of the wrong thing.
--
-- A column rather than a marker in alt_text, for the reason already written on `view` in this
-- table: it is a fact about the row, not a string for something else to parse.
--
-- Plain text, not an enum. A new enum value breaks the code already deployed against this
-- database -- the failure that took the alerts endpoint down on 23 September -- and this list
-- will grow (dupatta, and whatever the far end learns to take next).
ALTER TABLE "inventory_product_images" ADD COLUMN IF NOT EXISTS "slot" TEXT;

-- The other references for a four-view job, as {"blouse": url} or {"top": url, "bottom": url}.
--
-- One JSON column rather than a column per piece, because the set of pieces belongs to the far
-- end's API and will change without this table having an opinion about it.
--
-- Resolved when the job is QUEUED rather than when it runs, which is the reasoning already
-- applied to source_image_url beside it: the image rows may be deleted while the job waits, and
-- the far end fetches the addresses itself.
ALTER TABLE "photo_jobs" ADD COLUMN IF NOT EXISTS "reference_urls" JSONB;
