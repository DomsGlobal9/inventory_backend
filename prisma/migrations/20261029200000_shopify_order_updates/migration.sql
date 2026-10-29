-- What ScaleEzy has to tell Shopify about its orders (shipped with tracking, delivery progress,
-- cancelled, paid on delivery), and orders fulfilled by hand in Shopify. New table only.
CREATE TABLE IF NOT EXISTS "shopify_order_updates" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "dispatch_id" TEXT,
    "kind" TEXT NOT NULL,
    "event" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "shopify_fulfillment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at" TIMESTAMP(3),
    CONSTRAINT "shopify_order_updates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "shopify_order_updates_dedupe_key_key" ON "shopify_order_updates"("dedupe_key");
CREATE INDEX IF NOT EXISTS "shopify_order_updates_state_next_at_idx" ON "shopify_order_updates"("state", "next_at");
CREATE INDEX IF NOT EXISTS "shopify_order_updates_client_id_sales_order_id_idx" ON "shopify_order_updates"("client_id", "sales_order_id");
