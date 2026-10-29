-- Customer accounts on the online shop (29 Oct): the shop's own switches. New columns with defaults
-- only, so a build that does not know them keeps reading the table as before.
ALTER TABLE "online_shops" ADD COLUMN "accounts" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "online_shops" ADD COLUMN "wishlist" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "online_shops" ADD COLUMN "show_balances" BOOLEAN NOT NULL DEFAULT true;
