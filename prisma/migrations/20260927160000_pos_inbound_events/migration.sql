-- POS events are written down before they are worked out, so the till never waits for the
-- bookkeeping. Purely additive: a new table, no column or type touched anywhere else.
CREATE TABLE "pos_inbound_events" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "answer" TEXT,
    "order_number" TEXT,
    "detail" TEXT,
    "warnings" JSONB,
    "heartbeat_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "pos_inbound_events_pkey" PRIMARY KEY ("id")
);

-- The idempotency key. A retry upserts onto this row and is told where the original got to,
-- which is why a repeat costs one round trip and never sells the same saree twice.
CREATE UNIQUE INDEX "uq_pos_inbound_event" ON "pos_inbound_events"("client_id", "kind", "invoice_no");

-- What the worker scans: the oldest thing still waiting.
CREATE INDEX "pos_inbound_events_status_received_at_idx" ON "pos_inbound_events"("status", "received_at");
CREATE INDEX "pos_inbound_events_client_id_status_idx" ON "pos_inbound_events"("client_id", "status");
