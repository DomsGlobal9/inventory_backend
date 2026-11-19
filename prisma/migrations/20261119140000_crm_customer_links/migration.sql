-- ScaleEzy CRM owns who a customer is for a shop with CRM on (19 Nov 2026).
-- New tables only: nothing existing changes, so the build already live keeps working.

CREATE TABLE "crm_customer_links" (
    "customer_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "crm_customer_id" TEXT,
    "linked_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_try_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_customer_links_pkey" PRIMARY KEY ("customer_id")
);

CREATE INDEX "crm_customer_links_client_id_crm_customer_id_idx" ON "crm_customer_links"("client_id", "crm_customer_id");
CREATE INDEX "crm_customer_links_next_try_at_idx" ON "crm_customer_links"("next_try_at");

ALTER TABLE "crm_customer_links" ADD CONSTRAINT "crm_customer_links_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "crm_inbound_events" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "detail" JSONB,
    CONSTRAINT "crm_inbound_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crm_inbound_events_client_id_received_at_idx" ON "crm_inbound_events"("client_id", "received_at");
