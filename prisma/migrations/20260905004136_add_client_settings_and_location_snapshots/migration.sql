-- CreateTable
CREATE TABLE "client_settings" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "business_name" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_daily_location_snapshots" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "total_units" INTEGER NOT NULL DEFAULT 0,
    "total_value" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_daily_location_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_settings_client_id_key" ON "client_settings"("client_id");

-- CreateIndex
CREATE INDEX "inventory_daily_location_snapshots_client_id_snapshot_date_idx" ON "inventory_daily_location_snapshots"("client_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_daily_location_snapshots_location_id_snapshot_dat_key" ON "inventory_daily_location_snapshots"("location_id", "snapshot_date");

-- AddForeignKey
ALTER TABLE "inventory_daily_location_snapshots" ADD CONSTRAINT "inventory_daily_location_snapshots_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

