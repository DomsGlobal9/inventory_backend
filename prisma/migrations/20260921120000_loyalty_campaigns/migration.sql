-- CreateEnum
CREATE TYPE "LoyaltyEntryKind" AS ENUM ('EARNED', 'USED', 'RETURN_GIVEN_BACK', 'RETURN_TAKEN_BACK', 'BIRTHDAY', 'EXPIRED', 'ADJUSTED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SENDING', 'PAUSED', 'DONE', 'CANCELLED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'POINTS';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "anniversary" TEXT,
ADD COLUMN     "birthday" TEXT,
ADD COLUMN     "loyalty_active_at" TIMESTAMP(3),
ADD COLUMN     "loyalty_points" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "whatsapp_offers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsapp_offers_at" TIMESTAMP(3),
ADD COLUMN     "whatsapp_offers_by" TEXT,
ADD COLUMN     "whatsapp_stopped_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sales_returns" ADD COLUMN     "points_back" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "points_back_value" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "points_taken_back" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "loyalty_settings" (
    "client_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "points_per_100" INTEGER NOT NULL DEFAULT 1,
    "point_value_paise" INTEGER NOT NULL DEFAULT 100,
    "min_redeem_points" INTEGER NOT NULL DEFAULT 100,
    "max_redeem_percent" INTEGER NOT NULL DEFAULT 50,
    "expiry_months" INTEGER NOT NULL DEFAULT 12,
    "birthday_points" INTEGER NOT NULL DEFAULT 0,
    "notify_after_sale" BOOLEAN NOT NULL DEFAULT false,
    "birthday_wish" BOOLEAN NOT NULL DEFAULT false,
    "birthday_text" TEXT,
    "anniversary_wish" BOOLEAN NOT NULL DEFAULT false,
    "anniversary_text" TEXT,
    "expiry_reminder" BOOLEAN NOT NULL DEFAULT false,
    "auto_prepared_for" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_settings_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "loyalty_entries" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "kind" "LoyaltyEntryKind" NOT NULL,
    "points" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,
    "sales_order_id" TEXT,
    "sales_return_id" TEXT,
    "note" TEXT,
    "created_by_id" TEXT,
    "once_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "audience" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "start_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'WAITING',
    "skip_reason" TEXT,
    "message_id" TEXT,
    "handed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_entries_once_key_key" ON "loyalty_entries"("once_key");

-- CreateIndex
CREATE INDEX "loyalty_entries_client_id_customer_id_created_at_idx" ON "loyalty_entries"("client_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_entries_sales_order_id_idx" ON "loyalty_entries"("sales_order_id");

-- CreateIndex
CREATE INDEX "campaigns_client_id_status_idx" ON "campaigns"("client_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_client_id_created_at_idx" ON "campaigns"("client_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_message_id_key" ON "campaign_recipients"("message_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_id_state_idx" ON "campaign_recipients"("campaign_id", "state");

-- CreateIndex
CREATE INDEX "campaign_recipients_client_id_handed_at_idx" ON "campaign_recipients"("client_id", "handed_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_customer_id_key" ON "campaign_recipients"("campaign_id", "customer_id");

-- AddForeignKey
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

