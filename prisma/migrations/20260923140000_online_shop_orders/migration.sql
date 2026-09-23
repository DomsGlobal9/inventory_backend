-- Taking orders on a shop's own online shop. Add-only.

-- What the shop decides about taking orders at all.
ALTER TABLE "online_shops"
  ADD COLUMN IF NOT EXISTS "accepts_orders"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pay_on_delivery"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "pay_online"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "delivery_fee"         DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "free_delivery_above"  DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "min_order_value"      DECIMAL(10,2);

-- Money is never negative here, whatever a screen sends.
ALTER TABLE "online_shops"
  DROP CONSTRAINT IF EXISTS "online_shops_delivery_money_not_negative";
ALTER TABLE "online_shops"
  ADD CONSTRAINT "online_shops_delivery_money_not_negative"
  CHECK (
    "delivery_fee" >= 0
    AND ("free_delivery_above" IS NULL OR "free_delivery_above" >= 0)
    AND ("min_order_value" IS NULL OR "min_order_value" >= 0)
  );

DO $$ BEGIN
  CREATE TYPE "OnlineShopPayWay" AS ENUM ('ON_DELIVERY', 'ONLINE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "online_shop_orders" (
    "id"                 TEXT NOT NULL,
    "client_id"          TEXT NOT NULL,
    "sales_order_id"     TEXT NOT NULL,
    "placement_key"      TEXT NOT NULL,
    "token"              TEXT NOT NULL,
    "customer_phone"     TEXT,
    "phone_verified"     BOOLEAN NOT NULL DEFAULT false,
    "pay_way"            "OnlineShopPayWay" NOT NULL,
    "paid"               BOOLEAN NOT NULL DEFAULT false,
    "gateway_order_id"   TEXT,
    "gateway_payment_id" TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_shop_orders_pkey" PRIMARY KEY ("id")
);

-- One online-shop row per order, and one order per thing the browser sent: a double tap, a retry
-- after a timeout and two requests racing all end at the same single order.
CREATE UNIQUE INDEX IF NOT EXISTS "online_shop_orders_sales_order_id_key"
  ON "online_shop_orders"("sales_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "online_shop_orders_token_key"
  ON "online_shop_orders"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "online_shop_orders_client_id_placement_key_key"
  ON "online_shop_orders"("client_id", "placement_key");
CREATE INDEX IF NOT EXISTS "online_shop_orders_client_id_created_at_idx"
  ON "online_shop_orders"("client_id", "created_at");

-- The order is the sales order; this row only says it came from our shop page. Deleting the order
-- takes it with it, so nothing is left pointing at an order that is gone.
ALTER TABLE "online_shop_orders"
  DROP CONSTRAINT IF EXISTS "online_shop_orders_sales_order_id_fkey";
ALTER TABLE "online_shop_orders"
  ADD CONSTRAINT "online_shop_orders_sales_order_id_fkey"
  FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
