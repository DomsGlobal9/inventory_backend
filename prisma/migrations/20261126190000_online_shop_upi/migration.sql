-- Pay by UPI in the online shop (26 Nov 2026). Off for every shop until the owner sets it up and ticks it.
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "pay_by_upi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "upi_way" TEXT NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "upi_id" TEXT;
ALTER TABLE "online_shops" ADD COLUMN IF NOT EXISTS "upi_name" TEXT;

-- A shopper's "I paid by UPI" for an order sent straight to the shop's UPI ID; the owner confirms it.
CREATE TABLE IF NOT EXISTS "upi_claims" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "order_token" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "upi_id" TEXT NOT NULL,
    "upi_name" TEXT,
    "utr" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AWAITING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "upi_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "upi_claims_sales_order_id_key" ON "upi_claims"("sales_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "upi_claims_client_id_utr_key" ON "upi_claims"("client_id", "utr");
CREATE INDEX IF NOT EXISTS "upi_claims_client_id_status_idx" ON "upi_claims"("client_id", "status");
CREATE INDEX IF NOT EXISTS "upi_claims_status_expires_at_idx" ON "upi_claims"("status", "expires_at");
