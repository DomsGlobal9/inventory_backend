-- The shop floor for door check-ins (29 Oct): who a customer asked for, passing them on, done,
-- and how long they have waited (a second scan no longer restarts the clock). New columns only.
ALTER TABLE "store_checkins" ADD COLUMN "waiting_since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "store_checkins" ADD COLUMN "asked_for_id" TEXT;
ALTER TABLE "store_checkins" ADD COLUMN "asked_for_name" TEXT;
ALTER TABLE "store_checkins" ADD COLUMN "handoffs" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "store_checkins" ADD COLUMN "done_at" TIMESTAMP(3);
ALTER TABLE "store_checkins" ADD COLUMN "wait_alerted_at" TIMESTAMP(3);
ALTER TABLE "store_checkins" ADD COLUMN "wait_alert_id" TEXT;
-- Rows from before: they waited since they arrived.
UPDATE "store_checkins" SET "waiting_since" = "created_at";

-- The owner's bell: a customer has waited at the door with nobody taking them.
ALTER TYPE "InventoryAlertType" ADD VALUE IF NOT EXISTS 'CUSTOMER_WAITING';
