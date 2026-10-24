-- Couriers: the shop's list (Settings → Couriers), and who carried each dispatch with its tracking number.
-- A new table and new nullable columns only: builds already deployed never name them, and every existing
-- dispatch simply has no courier. Delivered uses the DispatchStatus value DELIVERED, which already exists.
CREATE TABLE IF NOT EXISTS "shop_couriers" (
  "id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "tracking_link" TEXT,
  "needs_number" BOOLEAN NOT NULL DEFAULT true,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shop_couriers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "shop_couriers_client_id_key_key" ON "shop_couriers"("client_id", "key");

ALTER TABLE "dispatches" ADD COLUMN IF NOT EXISTS "courier_id" TEXT;
ALTER TABLE "dispatches" ADD COLUMN IF NOT EXISTS "courier_name" TEXT;
ALTER TABLE "dispatches" ADD COLUMN IF NOT EXISTS "tracking_number" TEXT;
ALTER TABLE "dispatches" ADD COLUMN IF NOT EXISTS "tracking_url" TEXT;
ALTER TABLE "dispatches" ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_courier_id_fkey"
    FOREIGN KEY ("courier_id") REFERENCES "shop_couriers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
