-- CreateTable
CREATE TABLE "tryon_usage" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "started" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "viewsGenerated" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tryon_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_service_limits" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "service" "ClientService" NOT NULL,
    "monthly_limit" INTEGER,
    "updated_by_admin" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_service_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tryon_usage_client_id_day_idx" ON "tryon_usage"("client_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "tryon_usage_client_id_day_key" ON "tryon_usage"("client_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "client_service_limits_client_id_service_key" ON "client_service_limits"("client_id", "service");


