-- A shopper signed in to a shop's online store ("Sign in with WhatsApp"), one row per device.
-- A new table only: nothing existing changes, so a build that does not know it keeps working.
CREATE TABLE "online_shop_sessions" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "online_shop_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "online_shop_sessions_token_hash_key" ON "online_shop_sessions"("token_hash");
CREATE INDEX "online_shop_sessions_client_id_phone_idx" ON "online_shop_sessions"("client_id", "phone");
CREATE INDEX "online_shop_sessions_expires_at_idx" ON "online_shop_sessions"("expires_at");
