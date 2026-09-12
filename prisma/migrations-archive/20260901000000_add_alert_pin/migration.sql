-- AlterTable
ALTER TABLE "inventory_alerts" ADD COLUMN "is_pinned" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "inventory_alerts_is_pinned_idx" ON "inventory_alerts"("is_pinned");
