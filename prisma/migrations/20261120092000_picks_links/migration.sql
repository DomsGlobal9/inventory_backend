-- 20 Nov 2026. CRM's "Send picks" (A3).
-- A picks link is a PRIVATE reel link made for one customer: never on the shop's public reels page or the Reel links
-- list; it remembers the customer and who sent it. An online order bought through any reel link remembers its code, so
-- CRM can credit the person who sent it. New columns with defaults only (no enum): the live build is unaffected.
ALTER TABLE "reel_links" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'REEL';
ALTER TABLE "reel_links" ADD COLUMN "customer_id" TEXT;
ALTER TABLE "reel_links" ADD COLUMN "sent_by_name" TEXT;
CREATE INDEX "reel_links_client_id_purpose_idx" ON "reel_links"("client_id", "purpose");
ALTER TABLE "sales_orders" ADD COLUMN "reel_link_code" TEXT;
