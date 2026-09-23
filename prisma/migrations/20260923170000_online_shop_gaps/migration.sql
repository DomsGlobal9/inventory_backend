-- Closing the gaps in the online shop: proving a phone, letting go of stale holds, where a shop
-- will deliver, a banner that points at a department, and telling the shop an order arrived.
-- Add-only.

-- An order that just arrived, in the Alert Centre the shop already watches.
ALTER TYPE "InventoryAlertType" ADD VALUE IF NOT EXISTS 'ONLINE_ORDER';

-- A banner can point at one of the shop's own departments.
ALTER TYPE "OnlineShopBannerLink" ADD VALUE IF NOT EXISTS 'CATEGORY';

-- Where the shop will actually send things. Empty means everywhere.
ALTER TABLE "online_shops"
  ADD COLUMN IF NOT EXISTS "deliver_pincodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- When an UNPROVED order stops holding the shop's stock. Null on a proved one: that is a real
-- customer, and only the shop decides when to let it go.
ALTER TABLE "online_shop_orders"
  ADD COLUMN IF NOT EXISTS "hold_expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "online_shop_orders_hold_expires_at_idx"
  ON "online_shop_orders"("hold_expires_at");

-- Proving that a phone number belongs to whoever typed it. The code itself is never stored, only
-- a hash of it, so a copy of this table is not a list of live codes for every checkout in progress.
CREATE TABLE IF NOT EXISTS "online_shop_phone_codes" (
    "id"          TEXT NOT NULL,
    "client_id"   TEXT NOT NULL,
    "phone"       TEXT NOT NULL,
    "code_hash"   TEXT NOT NULL,
    "tries"       INTEGER NOT NULL DEFAULT 0,
    "sent_count"  INTEGER NOT NULL DEFAULT 1,
    "verified_at" TIMESTAMP(3),
    "expires_at"  TIMESTAMP(3) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_shop_phone_codes_pkey" PRIMARY KEY ("id")
);

-- One live code per number per shop: asking again replaces the last one rather than leaving two
-- codes that both work.
CREATE UNIQUE INDEX IF NOT EXISTS "online_shop_phone_codes_client_id_phone_key"
  ON "online_shop_phone_codes"("client_id", "phone");
CREATE INDEX IF NOT EXISTS "online_shop_phone_codes_expires_at_idx"
  ON "online_shop_phone_codes"("expires_at");
