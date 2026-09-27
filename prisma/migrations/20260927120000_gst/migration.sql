-- GST: the columns a tax invoice needs.
--
-- Until now there was no HSN anywhere, no tax rate anywhere, and `sales_orders.tax_amount` was
-- only ever passed in or read back -- the one place it was genuinely computed is Shopify
-- ingestion, where Shopify did the maths. Every bill this system has issued carries zero tax.
--
-- ADDITIVE ONLY, and every column is nullable or carries a default. A deployment still running
-- the previous code neither sees these nor needs them. No value is added to any enum -- the two
-- new kinds of thing here, `gst_registration` and `document_kind`, are TEXT for exactly that
-- reason: a sixth value next year must not be able to repeat 23 September, when a new
-- InventoryAlertType value took the alerts endpoint down.
--
-- Nothing is backfilled. Products have no HSN until a shop sets one, and every order that already
-- exists keeps its null tax columns forever. Old bills are never retro-taxed: the tax on a sale is
-- what was charged that day, not what today's rules would say.

-- ── What a product is, for tax ──────────────────────────────────────────────────────────────
--
-- Set by the shop, never guessed. A saree is FABRIC and is 5% whatever it costs -- a Rs 40,000
-- kanchipuram is still 5%. A stitched saree-style gown is APPAREL: 5% up to Rs 2,500 a piece and
-- 18% above. Only the shop knows which of the two a given product is. (Both rules are as of
-- 22 September 2025, when the old Rs 1,000 threshold and the 12% slab were removed.)
ALTER TABLE "inventory_products"
  ADD COLUMN IF NOT EXISTS "hsn_code"           TEXT,
  -- Basis points: 500 = 5%, 1800 = 18%, 0 = exempt. NULL means "not set yet", which is NOT the
  -- same as zero: a registered shop must not be able to issue a tax invoice for it.
  ADD COLUMN IF NOT EXISTS "tax_rate_bps"       INTEGER,
  -- True for stitched apparel, where the rate depends on what one piece sells for.
  ADD COLUMN IF NOT EXISTS "tax_slabbed"        BOOLEAN NOT NULL DEFAULT false,
  -- Stitched apparel near the threshold has to be priced EXCLUSIVE of tax. A tax-inclusive price
  -- between Rs 2,625 and Rs 2,950 has no self-consistent rate: at 5% the taxable value comes out
  -- above Rs 2,500 (so 5% was wrong) and at 18% below it (so 18% was wrong). Fabric -- which is
  -- every saree -- stays inclusive, so nothing about today's pricing changes.
  ADD COLUMN IF NOT EXISTS "price_is_exclusive" BOOLEAN NOT NULL DEFAULT false;

-- A style whose variants are not all the same thing: a saree sold with a stitched blouse.
-- NULL means "use the product's".
ALTER TABLE "inventory_product_variants"
  ADD COLUMN IF NOT EXISTS "hsn_code"     TEXT,
  ADD COLUMN IF NOT EXISTS "tax_rate_bps" INTEGER;

-- ── What the shop is allowed to issue ───────────────────────────────────────────────────────
--
-- This is worse to get wrong than a rate. A composition dealer that charges GST is collecting tax
-- it has no right to collect, and must issue a Bill of Supply that SAYS it is not eligible. An
-- unregistered shop has no GSTIN to print at all. A shop that has merely typed a GST number into
-- settings is not automatically a regular dealer, so this cannot be inferred from gst_number.
--
-- Defaults to UNREGISTERED deliberately: the safe end. A shop that has not said what it is does
-- not start charging tax by accident.
ALTER TABLE "client_settings"
  ADD COLUMN IF NOT EXISTS "gst_registration"           TEXT    NOT NULL DEFAULT 'UNREGISTERED',
  -- Two digits, e.g. '36' for Telangana. Compared against the place of supply to decide
  -- CGST+SGST against IGST -- the split is decided by where the goods GO, not where the shop is.
  ADD COLUMN IF NOT EXISTS "gst_state_code"             TEXT,
  -- 4 HSN digits up to Rs 5 crore, 6 above; and the same line is what makes e-invoicing due.
  ADD COLUMN IF NOT EXISTS "turnover_above_five_crore"  BOOLEAN NOT NULL DEFAULT false;

-- ── The frozen answer, on the line ──────────────────────────────────────────────────────────
--
-- The rate charged, stored at the moment of sale, never looked up again. This is the column set
-- that makes a reprint honest: the rates changed on 22 September 2025, so a bill from the week
-- before must show what the customer actually paid. BIGINT because everything monetary here is
-- whole paise, like the rest of pricing.
ALTER TABLE "sales_order_items"
  ADD COLUMN IF NOT EXISTS "hsn_code"            TEXT,
  ADD COLUMN IF NOT EXISTS "tax_rate_bps"        INTEGER,
  ADD COLUMN IF NOT EXISTS "taxable_value_minor" BIGINT,
  ADD COLUMN IF NOT EXISTS "cgst_minor"          BIGINT,
  ADD COLUMN IF NOT EXISTS "sgst_minor"          BIGINT,
  ADD COLUMN IF NOT EXISTS "igst_minor"          BIGINT;

-- ── The document ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "sales_orders"
  ADD COLUMN IF NOT EXISTS "place_of_supply_state_code" TEXT,
  ADD COLUMN IF NOT EXISTS "inter_state"                BOOLEAN NOT NULL DEFAULT false,
  -- The bill is rounded to the nearest rupee once, and the difference kept here as its own
  -- visible line. Never achieved by bending a tax figure: the tax figures are what get reported,
  -- and adjusting one to tidy a total is how a return stops reconciling.
  ADD COLUMN IF NOT EXISTS "round_off_minor"            BIGINT  NOT NULL DEFAULT 0,
  -- TAX_INVOICE | BILL_OF_SUPPLY | RECEIPT, decided by the shop's registration.
  ADD COLUMN IF NOT EXISTS "document_kind"              TEXT,
  -- Unbroken, per financial year (April-March), per shop, per series, allocated inside the same
  -- transaction that saves the sale. A gap in the series is a question the shop has to answer to
  -- a tax officer. Separate series per channel with distinct prefixes -- the till and the online
  -- shop will each have their own, decided rather than discovered at the first audit.
  ADD COLUMN IF NOT EXISTS "invoice_series"             TEXT,
  ADD COLUMN IF NOT EXISTS "invoice_number"             INTEGER,
  ADD COLUMN IF NOT EXISTS "invoice_financial_year"     TEXT;

-- One invoice number per series, per financial year, per shop. The partial index means orders
-- that carry no invoice number at all -- every one that exists today, and every draft -- do not
-- collide with each other on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "sales_orders_invoice_number_unique"
  ON "sales_orders" ("client_id", "invoice_series", "invoice_financial_year", "invoice_number")
  WHERE "invoice_number" IS NOT NULL;

-- Finding a product a shop has not finished setting up, which is what blocks a tax invoice.
CREATE INDEX IF NOT EXISTS "inventory_products_missing_hsn"
  ON "inventory_products" ("client_id")
  WHERE "hsn_code" IS NULL;
