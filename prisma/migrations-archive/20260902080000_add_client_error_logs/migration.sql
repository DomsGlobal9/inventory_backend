-- CreateTable
CREATE TABLE "client_error_logs" (
    "id" TEXT NOT NULL,
    "client_id" TEXT,
    "user_id" TEXT,
    "user_email" TEXT,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "route" TEXT,
    "status_code" INTEGER,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_error_logs_client_id_idx" ON "client_error_logs"("client_id");

-- CreateIndex
CREATE INDEX "client_error_logs_created_at_idx" ON "client_error_logs"("created_at");
