-- Shopify's three privacy webhooks, handled for real.
--
-- customers/data_request, customers/redact and shop/redact were acknowledged and ignored on the
-- grounds that no Shopify customer data was stored. Order ingestion changed that: a Shopify order
-- now creates a customer (name, email, phone, addresses), copies those details onto the sales
-- order, and keeps the webhook body verbatim in the order inbox for replay.

-- 1. Which Shopify store a row came from.
--
-- A workspace can connect more than one store, and shop/redact asks us to erase ONE store's
-- customer data. Neither sales_orders.source_system ('SHOPIFY') nor customers.external_customer_id
-- ('shopify:<id>') says which store, so without this the only safe answers would be "erase every
-- Shopify customer the workspace has" or "erase nothing". Null for everything not from Shopify,
-- and for the shared "Online guest", which holds no personal data and serves every store.
ALTER TABLE "customers" ADD COLUMN "source_store" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "source_store" TEXT;

-- Existing Shopify rows can only be attributed where the workspace has exactly one store; with
-- several there is no record of which store sent what, and a guess here would decide whose data
-- is erased later. (On 15 Sep 2026 there were no Shopify rows at all, so this is belt and braces.)
UPDATE "sales_orders" so
   SET "source_store" = i."shop_domain"
  FROM "shopify_installations" i
 WHERE so."source_system" = 'SHOPIFY'
   AND so."source_store" IS NULL
   AND i."client_id" = so."client_id"
   AND (SELECT count(*) FROM "shopify_installations" j WHERE j."client_id" = so."client_id") = 1;

UPDATE "customers" c
   SET "source_store" = i."shop_domain"
  FROM "shopify_installations" i
 WHERE c."external_customer_id" LIKE 'shopify:%'
   AND c."external_customer_id" <> 'shopify:guest'
   AND c."source_store" IS NULL
   AND i."client_id" = c."client_id"
   AND (SELECT count(*) FROM "shopify_installations" j WHERE j."client_id" = c."client_id") = 1;

CREATE INDEX "customers_client_id_source_store_idx" ON "customers"("client_id", "source_store");
CREATE INDEX "sales_orders_client_id_source_store_idx" ON "sales_orders"("client_id", "source_store");

-- 2. Every privacy request Shopify sent, and what was done about it.
--
-- The record Shopify's review expects to exist, and the merchant's list of data requests to answer.
-- It holds identifiers and counts only -- never a copy of the personal data itself. A data request
-- is answered by reading what we hold at the moment the merchant exports it, so there is no second
-- copy of anyone's address sitting here waiting to be redacted in turn.
CREATE TABLE "shopify_privacy_requests" (
  "id"                  TEXT NOT NULL,
  "shop_domain"         TEXT NOT NULL,
  "client_id"           TEXT,
  "topic"               TEXT NOT NULL,
  "webhook_id"          TEXT NOT NULL,
  "shopify_customer_id" TEXT,
  "shopify_request_id"  TEXT,
  "shopify_order_ids"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"              TEXT NOT NULL,
  "summary"             JSONB,
  "detail"              TEXT,
  "completed_at"        TIMESTAMP(3),
  "exported_at"         TIMESTAMP(3),
  "exported_by"         TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shopify_privacy_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_privacy_request_webhook" ON "shopify_privacy_requests"("webhook_id", "topic");
CREATE INDEX "shopify_privacy_requests_client_id_created_at_idx" ON "shopify_privacy_requests"("client_id", "created_at");
CREATE INDEX "shopify_privacy_requests_shop_domain_created_at_idx" ON "shopify_privacy_requests"("shop_domain", "created_at");
