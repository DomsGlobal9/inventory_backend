-- "See it on you" on a shop's own product pages. Off unless the shop asks for it, because every
-- try-on spends a generation from that shop's own allowance. Add-only.
ALTER TABLE "online_shops"
  ADD COLUMN IF NOT EXISTS "try_on" BOOLEAN NOT NULL DEFAULT false;
