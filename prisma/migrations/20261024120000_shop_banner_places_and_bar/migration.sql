-- Online shop: where each banner shows, between which dates, and the one-line announcement bar.
-- New columns only, all with defaults or nullable: builds already deployed never name them. Every
-- existing banner gets HOME_TOP, so the shop looks exactly as it did until the owner changes it.
ALTER TABLE "online_shop_banners" ADD COLUMN IF NOT EXISTS "placements" TEXT[] NOT NULL DEFAULT ARRAY['HOME_TOP']::TEXT[];
ALTER TABLE "online_shop_banners" ADD COLUMN IF NOT EXISTS "starts_at" TIMESTAMP(3);
ALTER TABLE "online_shop_banners" ADD COLUMN IF NOT EXISTS "ends_at" TIMESTAMP(3);

ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "announcement_text" TEXT;
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "announcement_link_kind" "OnlineShopBannerLink" NOT NULL DEFAULT 'NONE';
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "announcement_link_value" TEXT;
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "announcement_active" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "announcement_starts_at" TIMESTAMP(3);
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "announcement_ends_at" TIMESTAMP(3);
