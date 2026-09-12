-- A price we quoted, kept so an order can be held to it.
--
-- Without this an offer that ends at midnight prices a basket at 23:59:58 and charges a different
-- amount when the customer presses pay at 00:00:03. The customer saw a number; charging more is
-- not acceptable, and re-pricing at order time is exactly how that happens.
--
-- Fifteen minutes: long enough for a checkout, short enough that an expired sale is not honoured
-- for hours.
CREATE TABLE "pricing_quotes" (
  "id"             TEXT NOT NULL,
  "client_id"      TEXT NOT NULL,
  "location_id"    TEXT NOT NULL,
  "channel"        "SalesChannel" NOT NULL,
  "customer_id"    TEXT,
  -- A fingerprint of what was asked. An order arriving with a different basket than the one
  -- quoted must not be given the quoted price.
  "input_hash"     TEXT NOT NULL,
  -- The whole priced result, as it was shown. A record of what somebody was told.
  "result"         JSONB NOT NULL,
  "subtotal"       DECIMAL(10,2) NOT NULL,
  "discount"       DECIMAL(10,2) NOT NULL,
  "total"          DECIMAL(10,2) NOT NULL,
  "expires_at"     TIMESTAMP(3) NOT NULL,
  -- A quote is good once. Otherwise one checkout's price could be replayed onto ten orders.
  "consumed_at"    TIMESTAMP(3),
  "sales_order_id" TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pricing_quotes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pricing_quotes_client_id_expires_at_idx" ON "pricing_quotes"("client_id", "expires_at");
CREATE INDEX "pricing_quotes_sales_order_id_idx" ON "pricing_quotes"("sales_order_id");
