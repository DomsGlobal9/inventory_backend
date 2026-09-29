-- Each shop's own payment-gateway account, for taking money in its online shop
-- (PLAN-online-shop-payments.md). The customer pays the shop's own Razorpay account; ScaleEzy never
-- holds the money.
--
-- Additive only: one new table, nothing existing is altered, and the deployed build never selects
-- it. No enum is created or extended -- gateway, mode and status are TEXT, because adding a value to
-- a Postgres enum is what took the alerts endpoint down on 23 September.

-- CreateTable
CREATE TABLE "shop_payment_accounts" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'RAZORPAY',
    "key_id" TEXT NOT NULL,
    "key_secret_encrypted" TEXT NOT NULL,
    "webhook_secret_encrypted" TEXT NOT NULL,
    "webhook_token" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "checked_at" TIMESTAMP(3),
    "check_message" TEXT,
    "added_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_payment_accounts_pkey" PRIMARY KEY ("id")
);

-- One gateway account per shop.
CREATE UNIQUE INDEX "shop_payment_accounts_client_id_key" ON "shop_payment_accounts"("client_id");

-- The webhook address carries this; it must find exactly one shop.
CREATE UNIQUE INDEX "shop_payment_accounts_webhook_token_key" ON "shop_payment_accounts"("webhook_token");

-- Two shops, one gateway account: refused.
CREATE UNIQUE INDEX "shop_payment_accounts_gateway_key_id_key" ON "shop_payment_accounts"("gateway", "key_id");
