-- Try-on failures with the real reason, for the Platform Console. Additive; no enums.
CREATE TABLE "tryon_failures" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "place" TEXT NOT NULL,
    "http_status" INTEGER,
    "code" TEXT,
    "error" TEXT NOT NULL,
    "shown_message" TEXT,
    "product_id" TEXT,
    "job_id" TEXT,
    "attempt" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tryon_failures_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tryon_failures_created_at_idx" ON "tryon_failures"("created_at");
CREATE INDEX "tryon_failures_client_id_created_at_idx" ON "tryon_failures"("client_id", "created_at");
