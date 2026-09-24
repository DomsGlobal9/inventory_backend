-- Which of the four generated views a photograph is.
--
-- Try-on has to send the FRONT view of the colour the shopper is looking at. Nothing in the
-- database said which photograph was the front one: the four generated views were saved as
-- ordinary photographs, and the only trace of "front" was in the alt text and the file name.
-- Reading a column is a fact; parsing a sentence a human can edit is a guess.

-- TEXT, not an enum. Adding a value to a Postgres enum breaks the code already deployed against
-- this database -- an older Prisma client throws on a value it has never heard of. A new nullable
-- column is invisible to a client that does not select it.
ALTER TABLE "inventory_product_images" ADD COLUMN IF NOT EXISTS "view" TEXT;

-- Filling it in for the photographs already here.
--
-- The publish step writes both the file name (front.jpg) and the alt text ("... front view"), and
-- has done since generation existed. Both are required to match, so a shop that happens to have
-- uploaded its own file called front.jpg is not relabelled as a generated front view.
UPDATE "inventory_product_images"
SET "view" = v.name
FROM (VALUES ('front'), ('left'), ('right'), ('back')) AS v(name)
WHERE "inventory_product_images"."view" IS NULL
  AND "inventory_product_images"."file_name" = v.name || '.jpg'
  AND "inventory_product_images"."alt_text" LIKE '% ' || v.name || ' view';

-- A photograph that names a view was made by Try-On, whatever else we knew about it. The
-- `generated` column only exists as of today, so every view generated before that is still
-- marked as the shop's own work -- which would put four model shots ahead of the shop's real
-- photograph in its own gallery.
UPDATE "inventory_product_images" SET "generated" = true
WHERE "view" IS NOT NULL AND "generated" = false;

CREATE INDEX IF NOT EXISTS "inventory_product_images_view_idx"
  ON "inventory_product_images"("variant_id", "view");
