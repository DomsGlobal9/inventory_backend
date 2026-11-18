-- Customer groups owned by ScaleEzy CRM (18 Nov 2026): one row per shop whose groups CRM writes as a
-- read-only copy. A new table only; nothing existing changes, so a build without it keeps working.
CREATE TABLE IF NOT EXISTS "crm_group_projections" (
    "client_id" TEXT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "groups" INTEGER NOT NULL DEFAULT 0,
    "members" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "crm_group_projections_pkey" PRIMARY KEY ("client_id")
);
