-- Boutique payments (20 Nov 2026): money for boutique work (a stitching advance, an alteration) taken through the shop's
-- own Razorpay, asked for by the Boutique app. Not a shop sale: kept apart, told to the app. Additive only; text, no enum.

CREATE TABLE "boutique_payments" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "gateway_order_id" TEXT,
    "qr_id" TEXT,
    "qr_image_url" TEXT,
    "close_by" TIMESTAMP(3),
    "payment_id" TEXT,
    "utr" TEXT,
    "paid_paise" INTEGER NOT NULL DEFAULT 0,
    "refunded_paise" INTEGER NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMP(3),
    "refunds" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "boutique_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "boutique_payments_client_id_created_at_idx" ON "boutique_payments"("client_id", "created_at");
CREATE INDEX "boutique_payments_client_id_reference_idx" ON "boutique_payments"("client_id", "reference");
CREATE INDEX "boutique_payments_gateway_order_id_idx" ON "boutique_payments"("gateway_order_id");
CREATE INDEX "boutique_payments_qr_id_idx" ON "boutique_payments"("qr_id");
