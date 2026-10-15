-- Door QR check-ins: a customer at a store's door, for "In the store now". Additive; no enums.
CREATE TABLE "store_checkins" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "customer_id" TEXT,
    "taken_by_id" TEXT,
    "taken_by_name" TEXT,
    "taken_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_checkins_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "store_checkins_client_id_location_id_created_at_idx" ON "store_checkins"("client_id", "location_id", "created_at");
