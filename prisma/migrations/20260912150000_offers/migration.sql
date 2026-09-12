-- Phase 2: offers.
--
-- One place a merchant writes a discount, whichever storefront it sells through. Nothing here
-- APPLIES one -- the engine that prices a basket is Phase 3 and reads these tables.

CREATE TYPE "OfferStatus"    AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'ARCHIVED');
CREATE TYPE "OfferTrigger"   AS ENUM ('AUTOMATIC', 'CODE');
CREATE TYPE "OfferValueType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'FIXED_PRICE');
CREATE TYPE "OfferScope"     AS ENUM ('ALL', 'CATEGORY', 'PRODUCT', 'VARIANT');
CREATE TYPE "OfferLevel"     AS ENUM ('LINE', 'ORDER');

CREATE TABLE "offers" (
  "id"                       TEXT NOT NULL,
  "client_id"                TEXT NOT NULL,
  "offer_code"               TEXT NOT NULL,
  "name"                     TEXT NOT NULL,
  "description"              TEXT,
  "trigger"                  "OfferTrigger" NOT NULL DEFAULT 'AUTOMATIC',
  "coupon_code"              TEXT,
  "level"                    "OfferLevel" NOT NULL DEFAULT 'LINE',
  "value_type"               "OfferValueType" NOT NULL,
  "value"                    DECIMAL(10,2) NOT NULL,
  "max_discount"             DECIMAL(10,2),
  "scope"                    "OfferScope" NOT NULL DEFAULT 'ALL',
  "min_subtotal"             DECIMAL(10,2),
  "min_quantity"             INTEGER,
  "channels"                 "SalesChannel"[],
  "location_ids"             TEXT[],
  "starts_at"                TIMESTAMP(3) NOT NULL,
  "ends_at"                  TIMESTAMP(3),
  "usage_limit"              INTEGER,
  "usage_limit_per_customer" INTEGER,
  "usage_count"              INTEGER NOT NULL DEFAULT 0,
  "priority"                 INTEGER NOT NULL DEFAULT 0,
  "stackable"                BOOLEAN NOT NULL DEFAULT false,
  "status"                   "OfferStatus" NOT NULL DEFAULT 'DRAFT',
  "current_version_id"       TEXT,
  "created_by"               TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,
  "archived_at"              TIMESTAMP(3),
  CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "offers_client_id_offer_code_key" ON "offers"("client_id", "offer_code");
-- One live code per shop. Two offers answering to DEEPAVALI is a question with no right answer.
CREATE UNIQUE INDEX "offers_client_id_coupon_code_key" ON "offers"("client_id", "coupon_code");
-- The engine's hot path: which offers are live for this shop right now.
CREATE INDEX "offers_client_id_status_starts_at_ends_at_idx" ON "offers"("client_id", "status", "starts_at", "ends_at");

CREATE TABLE "offer_targets" (
  "id"         TEXT NOT NULL,
  "offer_id"   TEXT NOT NULL,
  "scope"      "OfferScope" NOT NULL,
  "ref_id"     TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offer_targets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "offer_targets_offer_id_scope_ref_id_key" ON "offer_targets"("offer_id", "scope", "ref_id");
CREATE INDEX "offer_targets_offer_id_idx" ON "offer_targets"("offer_id");

ALTER TABLE "offer_targets"
  ADD CONSTRAINT "offer_targets_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the rule said, at a moment. Immutable, and what lets an order explain itself six months
-- later: an order records a VERSION, so editing "20% off" down to "10% off" in November cannot
-- rewrite what October's customers were charged.
CREATE TABLE "offer_versions" (
  "id"          TEXT NOT NULL,
  "offer_id"    TEXT NOT NULL,
  "version"     INTEGER NOT NULL,
  "snapshot"    JSONB NOT NULL,
  "changed_by"  TEXT,
  "change_note" TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offer_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "offer_versions_offer_id_version_key" ON "offer_versions"("offer_id", "version");
CREATE INDEX "offer_versions_offer_id_idx" ON "offer_versions"("offer_id");

ALTER TABLE "offer_versions"
  ADD CONSTRAINT "offer_versions_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "offer_redemptions" (
  "id"               TEXT NOT NULL,
  "client_id"        TEXT NOT NULL,
  "offer_id"         TEXT NOT NULL,
  "offer_version_id" TEXT NOT NULL,
  "sales_order_id"   TEXT NOT NULL,
  "customer_id"      TEXT,
  "amount"           DECIMAL(10,2) NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'COUNTED',
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offer_redemptions_pkey" PRIMARY KEY ("id")
);

-- An offer counts once per order, however many lines it touched.
CREATE UNIQUE INDEX "uq_redemption_offer_order" ON "offer_redemptions"("offer_id", "sales_order_id");
CREATE INDEX "offer_redemptions_client_id_offer_id_idx" ON "offer_redemptions"("client_id", "offer_id");
CREATE INDEX "offer_redemptions_sales_order_id_idx" ON "offer_redemptions"("sales_order_id");
-- Per-customer limits are counted from here.
CREATE INDEX "offer_redemptions_customer_id_idx" ON "offer_redemptions"("customer_id");

ALTER TABLE "offer_redemptions"
  ADD CONSTRAINT "offer_redemptions_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: a version an order points at must not be removable while the order
-- still needs it to explain itself.
ALTER TABLE "offer_redemptions"
  ADD CONSTRAINT "offer_redemptions_offer_version_id_fkey"
  FOREIGN KEY ("offer_version_id") REFERENCES "offer_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
