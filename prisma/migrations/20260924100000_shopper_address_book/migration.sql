-- Saved addresses for a shopper who has proved their number, and the browser-bound proof they
-- are read with.
--
-- Additive only: nothing existing is rewritten, so an older build carries on reading and writing
-- customers exactly as it did. (A lesson from ONLINE_ORDER: a value added to an ENUM is not
-- additive for older readers. New tables and new nullable columns are.)

CREATE TABLE "customer_addresses" (
    "id"          TEXT NOT NULL,
    "client_id"   TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "label"       TEXT,
    "name"        TEXT NOT NULL,
    "phone"       TEXT NOT NULL,
    "line"        TEXT NOT NULL,
    "pincode"     TEXT NOT NULL,
    "is_default"  BOOLEAN NOT NULL DEFAULT false,
    "deleted_at"  TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_addresses_client_id_customer_id_idx"
    ON "customer_addresses"("client_id", "customer_id");

ALTER TABLE "customer_addresses"
    ADD CONSTRAINT "customer_addresses_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The secret handed to the browser that typed the code back. `verified_at` says a number was
-- proved recently; it does not say who is asking now, which is fine for deciding whose order this
-- is and not remotely enough to hand over somebody's home address.
ALTER TABLE "online_shop_phone_codes" ADD COLUMN "session_token" TEXT;
ALTER TABLE "online_shop_phone_codes" ADD COLUMN "session_expires_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "online_shop_phone_codes_session_token_key"
    ON "online_shop_phone_codes"("session_token");
