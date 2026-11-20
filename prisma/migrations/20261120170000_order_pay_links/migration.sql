-- Pay links (20 Nov 2026): a link ScaleEzy CRM sends a customer to pay what is still due on one order, online,
-- through the shop's own Razorpay. Additive only: a new table, text status (no enum).

CREATE TABLE "order_pay_links" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "gateway_order_id" TEXT,
    "payment_id" TEXT,
    "paid_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_pay_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_pay_links_token_key" ON "order_pay_links"("token");
CREATE INDEX "order_pay_links_client_id_sales_order_id_idx" ON "order_pay_links"("client_id", "sales_order_id");
CREATE INDEX "order_pay_links_gateway_order_id_idx" ON "order_pay_links"("gateway_order_id");
