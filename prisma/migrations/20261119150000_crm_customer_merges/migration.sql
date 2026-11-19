-- ScaleEzy CRM joining two customers: what Inventory moved, so an undo puts back exactly that (19 Nov 2026).
-- A new table only.

CREATE TABLE "crm_customer_merges" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "kept_id" TEXT NOT NULL,
    "dropped_id" TEXT NOT NULL,
    "crm_kept_id" TEXT NOT NULL,
    "crm_dropped_id" TEXT NOT NULL,
    "crm_event_id" TEXT NOT NULL,
    "moved" JSONB NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "credit_paise" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMP(3),
    "undo_event_id" TEXT,
    "undo_note" TEXT,
    CONSTRAINT "crm_customer_merges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_customer_merges_crm_event_id_dropped_id_key" ON "crm_customer_merges"("crm_event_id", "dropped_id");
CREATE INDEX "crm_customer_merges_client_id_crm_dropped_id_idx" ON "crm_customer_merges"("client_id", "crm_dropped_id");
