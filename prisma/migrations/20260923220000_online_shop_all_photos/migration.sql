-- Whether a shop shows every photograph of a product, or only its finished ones.
--
-- A product whose views Try-On generated keeps the flat-lay it was generated from as a RAW_UPLOAD
-- reference, so five photographs here were four in the shop. Most shops want all five; the ones
-- that do not turn it off once for the whole catalogue rather than per product. Default true,
-- because showing what the shop uploaded is the less surprising of the two.
ALTER TABLE "online_shops"
  ADD COLUMN IF NOT EXISTS "show_all_photos" BOOLEAN NOT NULL DEFAULT true;
