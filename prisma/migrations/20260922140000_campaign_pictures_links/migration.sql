-- Campaigns: a picture, a short link per customer, what was sent (snapshot), templates, failure codes.
-- Additions only: new columns are empty or have defaults; nothing existing changes.
-- AlterEnum
ALTER TYPE "CampaignStatus" ADD VALUE 'PREPARING';

-- AlterTable
ALTER TABLE "whatsapp_messages" ADD COLUMN     "fail_code" TEXT;

-- AlterTable
ALTER TABLE "loyalty_settings" ADD COLUMN     "anniversary_media_id" TEXT,
ADD COLUMN     "birthday_media_id" TEXT;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "link" JSONB,
ADD COLUMN     "media_id" TEXT,
ADD COLUMN     "prepare_error" TEXT,
ADD COLUMN     "snapshot" JSONB;

-- AlterTable
ALTER TABLE "campaign_recipients" ADD COLUMN     "link_code" TEXT,
ADD COLUMN     "link_ref" TEXT,
ADD COLUMN     "skip_code" TEXT;

-- CreateTable
CREATE TABLE "campaign_media" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "product_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_templates" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "media_id" TEXT,
    "link" JSONB,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_media_storage_path_key" ON "campaign_media"("storage_path");

-- CreateIndex
CREATE INDEX "campaign_media_client_id_created_at_idx" ON "campaign_media"("client_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_templates_client_id_name_key" ON "campaign_templates"("client_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_link_ref_key" ON "campaign_recipients"("link_ref");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "campaign_media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_templates" ADD CONSTRAINT "campaign_templates_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "campaign_media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

