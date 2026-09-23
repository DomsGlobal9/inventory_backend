-- The shop's own online shop (PLAN-online-shop.md, Phase 1).
-- Add-only: two new tables, nothing existing is touched.

CREATE TABLE "online_shops" (
    "id"              TEXT NOT NULL,
    "client_id"       TEXT NOT NULL,
    "slug"            TEXT NOT NULL,
    "is_live"         BOOLEAN NOT NULL DEFAULT false,
    "display_name"    TEXT,
    "logo_url"        TEXT,
    "banner_url"      TEXT,
    "banner_path"     TEXT,
    "accent"          TEXT,
    "location_ids"    TEXT[],
    "hide_out_of_stock" BOOLEAN NOT NULL DEFAULT false,
    "return_policy"   TEXT,
    "grievance_name"  TEXT,
    "grievance_phone" TEXT,
    "grievance_email" TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_shops_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "online_shops_client_id_key" ON "online_shops"("client_id");
CREATE UNIQUE INDEX "online_shops_slug_key" ON "online_shops"("slug");

-- The address a customer taps. Checked in the database as well as in the code, because this one
-- ends up printed on posters and frozen into WhatsApp messages that cannot be edited afterwards:
-- lower-case letters, digits and single hyphens, 3-40 characters, never starting or ending with one.
ALTER TABLE "online_shops"
  ADD CONSTRAINT "online_shops_slug_shape"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 3 AND 40);

-- A slug is never handed to a different shop, even after the first one is deleted: a QR code on a
-- poster outlives the shop that printed it, and pointing it at somebody else's sarees would be
-- worse than pointing it at nothing.
CREATE TABLE "online_shop_slug_history" (
    "slug"        TEXT NOT NULL,
    "client_id"   TEXT NOT NULL,
    "taken_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "online_shop_slug_history_pkey" PRIMARY KEY ("slug")
);

CREATE INDEX "online_shop_slug_history_client_id_idx" ON "online_shop_slug_history"("client_id");
