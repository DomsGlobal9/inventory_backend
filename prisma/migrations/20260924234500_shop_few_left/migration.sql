-- "Only 3 left", on a shop that wants to say it.
--
-- The shopper's view deliberately carried no stock figure at all: sellable or not, nothing more.
-- The reasoning in shop.service.ts was that a stock count is the shop's business and saying "only
-- 2 left" is a decision for the SHOP to make. That reasoning still holds -- so this is the shop
-- making it, rather than the figure being published for everybody.
--
-- Default true: a saree shop wanting the last piece of something to sell is the ordinary case, and
-- what is revealed is capped at a handful (see FEW_LEFT in shop.service.ts) so a shop's real stock
-- level never leaves the building. A shop that would rather say nothing turns it off in Settings.
ALTER TABLE "online_shops"
  ADD COLUMN IF NOT EXISTS "show_few_left" BOOLEAN NOT NULL DEFAULT true;
