-- Photographs belong to a colour, not to the product.
--
-- A shop selling one saree in five colours photographed one of them, and every colour showed
-- that picture. The variant_id column has carried the right answer since the beginning and not
-- one of the 32 photographs in this database ever used it.
--
-- Two parts: the columns that let a shop's own photograph be told apart from a generated one,
-- and moving the photographs that exist down onto the colours they belong to.

-- ── 1. Telling a photograph apart from a generated view ───────────────────────────────────────
--
-- Plain columns, NOT a new value on the ProductImageType enum. Adding a value to an enum breaks
-- the deployed code that reads it -- an older Prisma client throws on a value it does not know,
-- which is exactly what took the alerts bell down on 23 September. A new column is invisible to
-- a client that does not select it.
ALTER TABLE "inventory_product_images"
  ADD COLUMN IF NOT EXISTS "generated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "generated_from_id" TEXT;

-- Self-referencing, and SET NULL rather than CASCADE: deleting the flat-lay a set was generated
-- from must not delete the four finished photographs made from it.
DO $$ BEGIN
  ALTER TABLE "inventory_product_images"
    ADD CONSTRAINT "inventory_product_images_generated_from_id_fkey"
    FOREIGN KEY ("generated_from_id") REFERENCES "inventory_product_images"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "inventory_product_images_generated_from_id_idx"
  ON "inventory_product_images"("generated_from_id");

-- Everything that already exists and is not a flat-lay reference was uploaded by a shop, so the
-- default of false is already right for it. The RAW_UPLOAD rows are flat-lays -- also uploaded,
-- also not generated -- so nothing needs correcting here. Stated rather than left implied,
-- because "we did not bother" and "we checked and there was nothing to do" look identical later.

-- ── 2. Moving the photographs onto their colours ──────────────────────────────────────────────

-- Kept before anything is moved. 32 rows; small enough to hold on to and worth far more than the
-- space it costs if this turns out to have been wrong.
CREATE TABLE IF NOT EXISTS "inventory_product_images_backup_20260924" AS
  SELECT * FROM "inventory_product_images" WHERE "variant_id" IS NULL;

-- One copy per variant of the product. A photograph of the red saree is a photograph of red/S,
-- red/M and red/L alike, and every reader in the app already asks a VARIANT what it looks like.
--
-- storage_path is copied as-is, so several rows point at one file in storage. That is deliberate
-- -- the bytes exist once -- and imageService.deleteImage removes the file only when the row
-- being deleted was the last one using that path.
--
-- is_primary is copied too: the primary photograph is scoped per variant (see addImage), so each
-- colour ending up with its own lead photograph is the shape the code already expects.
INSERT INTO "inventory_product_images"
  ("id", "product_id", "variant_id", "url", "storage_path", "file_name", "file_size",
   "alt_text", "is_primary", "image_type", "order_index", "created_at", "generated")
SELECT
  gen_random_uuid()::text, i."product_id", v."id", i."url", i."storage_path", i."file_name",
  i."file_size", i."alt_text", i."is_primary", i."image_type", i."order_index", i."created_at", false
FROM "inventory_product_images" i
JOIN "inventory_product_variants" v ON v."product_id" = i."product_id"
WHERE i."variant_id" IS NULL;

-- The originals go, but ONLY where a copy was actually made. A product with no variants keeps its
-- photographs exactly where they are -- deleting them would be losing them, and every reader in
-- the app still falls back to the product's own photographs when a variant has none.
DELETE FROM "inventory_product_images" i
WHERE i."variant_id" IS NULL
  AND EXISTS (SELECT 1 FROM "inventory_product_variants" v WHERE v."product_id" = i."product_id");
