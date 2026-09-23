-- Banners across the top of a shop's own online shop. Add-only.

CREATE TYPE "OnlineShopBannerLink" AS ENUM ('NONE', 'SEARCH', 'PRODUCT');

CREATE TABLE "online_shop_banners" (
    "id"            TEXT NOT NULL,
    "client_id"     TEXT NOT NULL,
    "image_url"     TEXT NOT NULL,
    "image_path"    TEXT,
    "width"         INTEGER NOT NULL,
    "height"        INTEGER NOT NULL,
    "heading"       TEXT,
    "subtext"       TEXT,
    "link_kind"     "OnlineShopBannerLink" NOT NULL DEFAULT 'NONE',
    "link_value"    TEXT,
    "order_index"   INTEGER NOT NULL DEFAULT 0,
    "active"        BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_shop_banners_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "online_shop_banners_client_id_order_index_idx"
  ON "online_shop_banners"("client_id", "order_index");

-- A banner that goes somewhere must say where. Checked here as well as in the code, because a
-- banner with a link and nothing to link to is a dead tap for every customer who tries it.
ALTER TABLE "online_shop_banners"
  ADD CONSTRAINT "online_shop_banners_link_has_value"
  CHECK ("link_kind" = 'NONE' OR ("link_value" IS NOT NULL AND length(btrim("link_value")) > 0));
