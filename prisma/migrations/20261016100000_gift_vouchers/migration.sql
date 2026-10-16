-- Gift vouchers (PLAN-gift-vouchers.md). Additive. The new PaymentMethod value is the one enum change:
-- the code that knows VOUCHER is deployed before any row carries it.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'VOUCHER';

CREATE TABLE "gift_vouchers" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "initial_paise" INTEGER NOT NULL,
    "balance_paise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sold_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sold_location_id" TEXT,
    "sold_connection_id" TEXT,
    "buyer_customer_id" TEXT,
    "buyer_name" TEXT,
    "buyer_phone" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gift_vouchers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gift_vouchers_client_id_code_key" ON "gift_vouchers"("client_id", "code");
CREATE UNIQUE INDEX "gift_vouchers_client_id_idempotency_key_key" ON "gift_vouchers"("client_id", "idempotency_key");
CREATE INDEX "gift_vouchers_client_id_sold_at_idx" ON "gift_vouchers"("client_id", "sold_at");

CREATE TABLE "gift_voucher_entries" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "voucher_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "balance_paise" INTEGER NOT NULL,
    "payments" JSONB,
    "location_id" TEXT,
    "sales_order_id" TEXT,
    "invoice_no" TEXT,
    "note" TEXT,
    "created_by" TEXT,
    "once_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gift_voucher_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gift_voucher_entries_once_key_key" ON "gift_voucher_entries"("once_key");
CREATE INDEX "gift_voucher_entries_client_id_voucher_id_created_at_idx" ON "gift_voucher_entries"("client_id", "voucher_id", "created_at");
CREATE INDEX "gift_voucher_entries_client_id_created_at_idx" ON "gift_voucher_entries"("client_id", "created_at");

CREATE TABLE "gift_voucher_settings" (
    "client_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "valid_months" INTEGER NOT NULL DEFAULT 12,
    "min_paise" INTEGER NOT NULL DEFAULT 50000,
    "max_paise" INTEGER NOT NULL DEFAULT 5000000,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gift_voucher_settings_pkey" PRIMARY KEY ("client_id")
);

-- A VOUCHER hold names a voucher, not a customer (a walk-in can spend one).
ALTER TABLE "pos_holds" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "pos_holds" ADD COLUMN "gift_voucher_id" TEXT;
CREATE INDEX "pos_holds_client_id_gift_voucher_id_status_idx" ON "pos_holds"("client_id", "gift_voucher_id", "status");
