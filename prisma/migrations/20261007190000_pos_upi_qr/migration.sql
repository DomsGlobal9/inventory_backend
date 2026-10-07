-- UPI QR at the POS till through the shop's own Razorpay account. Add-only: one boolean column
-- (default false, so every shop stays off) and one new table. No enum, nothing existing changed.
ALTER TABLE "shop_payment_accounts" ADD COLUMN IF NOT EXISTS "upi_qr_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "pos_upi_qrs" (
  "id"              TEXT NOT NULL,
  "client_id"       TEXT NOT NULL,
  "connection_id"   TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "qr_id"           TEXT NOT NULL,
  "amount_paise"    INTEGER NOT NULL,
  "invoice_ref"     TEXT,
  "image_url"       TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'WAITING',
  "payment_id"      TEXT,
  "utr"             TEXT,
  "paid_paise"      INTEGER,
  "paid_at"         TIMESTAMP(3),
  "close_by"        TIMESTAMP(3) NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pos_upi_qrs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "pos_upi_qrs_qr_id_key" ON "pos_upi_qrs"("qr_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pos_upi_qrs_client_id_idempotency_key_key" ON "pos_upi_qrs"("client_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "pos_upi_qrs_status_close_by_idx" ON "pos_upi_qrs"("status", "close_by");
