-- Proving the phone number on a signup enquiry, with a code sent on WhatsApp from ScaleEzy's own
-- number. Until now the form took a phone and never checked it.
--
-- Additive only: a new table and a new column with a default, so the deployed build carries on
-- reading and writing signup_leads exactly as it did. (No new enum values -- see the note on
-- ONLINE_ORDER for why that distinction matters against a shared database.)

CREATE TABLE "signup_phone_codes" (
    "id"         TEXT NOT NULL,
    "phone"      TEXT NOT NULL,
    "code_hash"  TEXT NOT NULL,
    "tries"      INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 1,
    "verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signup_phone_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signup_phone_codes_phone_key" ON "signup_phone_codes"("phone");
CREATE INDEX "signup_phone_codes_expires_at_idx" ON "signup_phone_codes"("expires_at");

-- False rather than true for rows already here: nobody proved those, and marking old leads as
-- verified would be a lie told once and believed for ever.
ALTER TABLE "signup_leads" ADD COLUMN "phone_verified" BOOLEAN NOT NULL DEFAULT false;
