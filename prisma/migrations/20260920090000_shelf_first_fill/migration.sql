-- CreateEnum
CREATE TYPE "SpotFillStateKind" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FirstFillState" AS ENUM ('NOT_STARTED', 'FILLING', 'FINISHED');

-- CreateTable
CREATE TABLE "spot_fill_states" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "spot_id" TEXT NOT NULL,
    "state" "SpotFillStateKind" NOT NULL DEFAULT 'NOT_STARTED',
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "finished_by" TEXT,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spot_fill_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_first_fills" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "state" "FirstFillState" NOT NULL DEFAULT 'NOT_STARTED',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "finished_by" TEXT,
    "ended_by_itself" BOOLEAN,
    "reopened_at" TIMESTAMP(3),
    "reopened_by" TEXT,
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_first_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shelf_fill_saves" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "spot_id" TEXT NOT NULL,
    "save_key" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shelf_fill_saves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spot_fill_states_spot_id_key" ON "spot_fill_states"("spot_id");

-- CreateIndex
CREATE INDEX "spot_fill_states_client_id_location_id_state_idx" ON "spot_fill_states"("client_id", "location_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "location_first_fills_location_id_key" ON "location_first_fills"("location_id");

-- CreateIndex
CREATE INDEX "location_first_fills_client_id_state_idx" ON "location_first_fills"("client_id", "state");

-- CreateIndex
CREATE INDEX "shelf_fill_saves_spot_id_idx" ON "shelf_fill_saves"("spot_id");

-- CreateIndex
CREATE UNIQUE INDEX "shelf_fill_saves_client_id_save_key_key" ON "shelf_fill_saves"("client_id", "save_key");

-- AddForeignKey
ALTER TABLE "spot_fill_states" ADD CONSTRAINT "spot_fill_states_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "storage_spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_first_fills" ADD CONSTRAINT "location_first_fills_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "uq_redemption_offer_order" RENAME TO "offer_redemptions_offer_id_sales_order_id_key";

-- RenameIndex
ALTER INDEX "uq_purchase_receipt_number" RENAME TO "purchase_receipts_client_id_receipt_number_key";

-- RenameIndex
ALTER INDEX "uq_purchase_receipt_request" RENAME TO "purchase_receipts_client_id_request_key_key";

-- RenameIndex
ALTER INDEX "uq_inbox_order_topic" RENAME TO "shopify_order_inbox_shop_domain_shopify_order_id_topic_key";

-- RenameIndex
ALTER INDEX "uq_privacy_request_webhook" RENAME TO "shopify_privacy_requests_webhook_id_topic_key";

