-- A boutique-only client asks to join ScaleEzy Inventory (16 Nov 2026). Additions only: one new table.

-- CreateTable
CREATE TABLE "boutique_join_requests" (
    "id" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "shop_name" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "owner_email" TEXT NOT NULL,
    "owner_phone" TEXT NOT NULL,
    "city" TEXT,
    "note" TEXT,
    "requested_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "reason" TEXT,
    "client_id" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boutique_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "boutique_join_requests_tenant_created_at_idx" ON "boutique_join_requests"("tenant", "created_at");

-- CreateIndex
CREATE INDEX "boutique_join_requests_status_created_at_idx" ON "boutique_join_requests"("status", "created_at");

-- Only one open request per boutique account at a time: two clicks in CRM-B, or two people, make one card.
CREATE UNIQUE INDEX "boutique_join_requests_one_open_per_tenant" ON "boutique_join_requests"("tenant") WHERE "status" IN ('WAITING', 'ACCEPTING');

ALTER TABLE "boutique_join_requests" ADD CONSTRAINT "boutique_join_requests_status_ok"
  CHECK ("status" IN ('WAITING', 'ACCEPTING', 'ACCEPTED', 'DECLINED', 'CANCELLED'));
