-- Taking money online (PLAN-online-shop-payments.md, sessions 2 and 3).
--
-- Additive only. Four new tables and one new payment method; nothing existing is altered.
--
-- PaymentMethod gains ONLINE. Safe to add on deploy: this runs in the build before the new code
-- starts, and no row can carry ONLINE until an owner has connected Razorpay AND switched paying
-- online on -- which the build that is still serving cannot do, because it refuses payOnline.
--
-- The order is NOT made when the customer presses Pay: online_payments and online_payment_holds
-- set the stock aside (counted in inventory_stocks.reserved_qty, like any order's reservation) and
-- the sales order is written only once the payment is confirmed.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'ONLINE';

-- CreateTable
CREATE TABLE "online_payments" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "placement_key" TEXT NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'RAZORPAY',
    "key_id" TEXT NOT NULL,
    "gateway_order_id" TEXT,
    "gateway_payment_id" TEXT,
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'STARTING',
    "method" TEXT,
    "checkout" JSONB,
    "input_hash" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "hold_expires_at" TIMESTAMP(3),
    "sales_order_id" TEXT,
    "last_fail_reason" TEXT,
    "attention_reason" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_payment_holds" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "online_payment_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_payment_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_refunds" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "online_payment_id" TEXT NOT NULL,
    "sales_order_id" TEXT,
    "purpose" TEXT NOT NULL,
    "once_key" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTING',
    "gateway_refund_id" TEXT,
    "reason" TEXT,
    "requested_by_id" TEXT,
    "fail_reason" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_webhook_receipts" (
    "id" TEXT NOT NULL,
    "client_id" TEXT,
    "gateway" TEXT NOT NULL,
    "event_id" TEXT,
    "event" TEXT,
    "signature_valid" BOOLEAN NOT NULL,
    "raw_body" TEXT NOT NULL,
    "outcome" TEXT,
    "error" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_webhook_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_token_key" ON "online_payments"("token");

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_gateway_order_id_key" ON "online_payments"("gateway_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_gateway_payment_id_key" ON "online_payments"("gateway_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_sales_order_id_key" ON "online_payments"("sales_order_id");

-- CreateIndex
CREATE INDEX "online_payments_client_id_placement_key_idx" ON "online_payments"("client_id", "placement_key");

-- CreateIndex
CREATE INDEX "online_payments_status_hold_expires_at_idx" ON "online_payments"("status", "hold_expires_at");

-- CreateIndex
CREATE INDEX "online_payments_client_id_created_at_idx" ON "online_payments"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "online_payment_holds_online_payment_id_idx" ON "online_payment_holds"("online_payment_id");

-- CreateIndex
CREATE INDEX "online_payment_holds_client_id_idx" ON "online_payment_holds"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_refunds_once_key_key" ON "online_refunds"("once_key");

-- CreateIndex
CREATE UNIQUE INDEX "online_refunds_gateway_refund_id_key" ON "online_refunds"("gateway_refund_id");

-- CreateIndex
CREATE INDEX "online_refunds_online_payment_id_idx" ON "online_refunds"("online_payment_id");

-- CreateIndex
CREATE INDEX "online_refunds_client_id_created_at_idx" ON "online_refunds"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "online_refunds_status_idx" ON "online_refunds"("status");

-- CreateIndex
CREATE INDEX "gateway_webhook_receipts_client_id_created_at_idx" ON "gateway_webhook_receipts"("client_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_webhook_receipts_gateway_client_id_event_id_key" ON "gateway_webhook_receipts"("gateway", "client_id", "event_id");

-- AddForeignKey
ALTER TABLE "online_payment_holds" ADD CONSTRAINT "online_payment_holds_online_payment_id_fkey" FOREIGN KEY ("online_payment_id") REFERENCES "online_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_refunds" ADD CONSTRAINT "online_refunds_online_payment_id_fkey" FOREIGN KEY ("online_payment_id") REFERENCES "online_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

