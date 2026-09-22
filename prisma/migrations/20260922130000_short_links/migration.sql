-- Short links (go.scaleezy.com): services/links. Two new tables only; nothing existing changes.
-- CreateEnum
CREATE TYPE "ShortLinkTarget" AS ENUM ('PRODUCT', 'SHOP', 'CAMPAIGN', 'WHATSAPP', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ShortLinkStatus" AS ENUM ('ACTIVE', 'DISABLED_BY_SHOP', 'DISABLED_BY_PLATFORM');

-- CreateEnum
CREATE TYPE "ShortLinkVisitor" AS ENUM ('HUMAN', 'BOT');

-- CreateTable
CREATE TABLE "short_links" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "owner_module" TEXT NOT NULL,
    "owner_ref" TEXT,
    "recipient_ref" TEXT,
    "target_type" "ShortLinkTarget" NOT NULL,
    "target" TEXT NOT NULL,
    "status" "ShortLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "disabled_at" TIMESTAMP(3),
    "disabled_by_id" TEXT,
    "disabled_note" TEXT,
    "tap_count" INTEGER NOT NULL DEFAULT 0,
    "bot_open_count" INTEGER NOT NULL DEFAULT 0,
    "first_tap_at" TIMESTAMP(3),
    "last_tap_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "short_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "short_link_taps" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "visitor" "ShortLinkVisitor" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "short_link_taps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "short_links_code_key" ON "short_links"("code");

-- CreateIndex
CREATE INDEX "short_links_expires_at_idx" ON "short_links"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "short_links_client_id_owner_module_owner_ref_recipient_ref_key" ON "short_links"("client_id", "owner_module", "owner_ref", "recipient_ref");

-- CreateIndex
CREATE INDEX "short_link_taps_link_id_at_idx" ON "short_link_taps"("link_id", "at");

-- CreateIndex
CREATE INDEX "short_link_taps_at_idx" ON "short_link_taps"("at");

-- AddForeignKey
ALTER TABLE "short_link_taps" ADD CONSTRAINT "short_link_taps_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "short_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guards the database keeps whatever the code does.
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_code_shape" CHECK ("code" ~ '^[A-Za-z0-9]{7}$');
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_counts" CHECK ("tap_count" >= 0 AND "bot_open_count" >= 0);
