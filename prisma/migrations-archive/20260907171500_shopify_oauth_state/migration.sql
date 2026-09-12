-- CreateTable
CREATE TABLE "shopify_oauth_states" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "client_id" TEXT,
    "started_by_user" TEXT,
    "consumed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shopify_oauth_states_nonce_key" ON "shopify_oauth_states"("nonce");

-- CreateIndex
CREATE INDEX "shopify_oauth_states_expires_at_idx" ON "shopify_oauth_states"("expires_at");


