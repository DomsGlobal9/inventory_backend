-- A shop's own square icon, for the browser tab, the bookmark and the phone home screen.
--
-- Two columns, not one: the URL is what the page prints, the path is what lets the old file be
-- deleted from storage when the shop replaces it. Without the path a shop that changes its icon
-- four times leaves four pictures behind that nothing will ever reach again.
--
-- Both nullable with no default, so a deployment still running the previous code neither sees nor
-- needs them. Empty means the page falls back to the shop's logo, as it did before this existed.
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "icon_url"  TEXT;
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "icon_path" TEXT;
