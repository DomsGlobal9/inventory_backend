-- Somebody wanted a piece that was sold out.
--
-- A sold-out colour is the one moment a shop learns about demand it cannot see anywhere else:
-- the customer arrived, wanted it, and left. Today the page offers "Ask if it is coming back",
-- which sends them to WhatsApp and leaves no record at all -- so a shop with twenty such
-- messages across three weeks has no way to know that eleven of them were for the same saree.
--
-- A NEW TABLE, deliberately, rather than a new InventoryAlertType. Adding a value to that enum
-- is what broke the alerts bell on 23 September: a deployed Prisma client that has not been
-- rebuilt throws when it reads a value it does not know, so every reader of inventory_alerts
-- would have to be redeployed before a single row could exist. A table nothing currently
-- selects from cannot do that to anybody.
--
-- No automatic message is promised. The shop sees who is waiting and rings them, which for a
-- saree shop -- where one piece is often literally one piece -- is the better call anyway.
CREATE TABLE IF NOT EXISTS "shop_interests" (
  "id"         TEXT NOT NULL,
  "client_id"  TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "variant_id" TEXT NOT NULL,
  -- Kept as given. This is how the shop rings them back, and the only reason the row exists.
  "phone"      TEXT NOT NULL,
  "name"       TEXT,
  -- Set when the shop has dealt with it, so the list is what is still outstanding rather than
  -- everything that ever happened.
  "handled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shop_interests_pkey" PRIMARY KEY ("id")
);

-- One row per person per piece. Somebody who asks twice is still one person waiting, and a
-- shop counting demand must not be told eleven when it is one customer pressing a button.
CREATE UNIQUE INDEX IF NOT EXISTS "shop_interests_variant_phone_key"
  ON "shop_interests" ("variant_id", "phone");

CREATE INDEX IF NOT EXISTS "shop_interests_client_id_idx"  ON "shop_interests" ("client_id");
CREATE INDEX IF NOT EXISTS "shop_interests_product_id_idx" ON "shop_interests" ("product_id");
CREATE INDEX IF NOT EXISTS "shop_interests_handled_at_idx" ON "shop_interests" ("handled_at");

-- Cascades: a variant or product that is deleted takes its waiting list with it. Nobody should
-- be rung about a saree the shop no longer sells.
ALTER TABLE "shop_interests"
  ADD CONSTRAINT "shop_interests_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shop_interests"
  ADD CONSTRAINT "shop_interests_variant_id_fkey"
  FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
