-- CreateTable
CREATE TABLE "inventory_alert_reads" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_alert_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_alert_reads_user_id_idx" ON "inventory_alert_reads"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_alert_reads_alert_id_user_id_key" ON "inventory_alert_reads"("alert_id", "user_id");

-- AddForeignKey
ALTER TABLE "inventory_alert_reads" ADD CONSTRAINT "inventory_alert_reads_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "inventory_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
