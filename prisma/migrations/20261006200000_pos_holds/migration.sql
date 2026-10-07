-- Loyalty points and store credit reserved by a till for one bill (contract §10). Add-only: a new
-- table, no enum, nothing existing touched.
CREATE TABLE IF NOT EXISTS "pos_holds" (
  "id"              TEXT NOT NULL,
  "client_id"       TEXT NOT NULL,
  "connection_id"   TEXT NOT NULL,
  "customer_id"     TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "amount"          INTEGER NOT NULL,
  "value_paise"     INTEGER NOT NULL,
  "bill_paise"      INTEGER NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'RESERVED',
  "invoice_no"      TEXT,
  "sales_order_id"  TEXT,
  "expires_at"      TIMESTAMP(3) NOT NULL,
  "confirmed_at"    TIMESTAMP(3),
  "released_at"     TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pos_holds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "pos_holds_client_id_idempotency_key_key" ON "pos_holds"("client_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "pos_holds_client_id_customer_id_status_idx" ON "pos_holds"("client_id", "customer_id", "status");
CREATE INDEX IF NOT EXISTS "pos_holds_status_expires_at_idx" ON "pos_holds"("status", "expires_at");
