-- Erased customers, for the POS till to erase its own copy (12 Nov 2026). The number the person had at the
-- moment of the erase (the customer row no longer has it), kept 30 days only, then deleted. The till asks
-- GET /pos/v1/erasures?since=<sequence> with its key. A new table, so a build that does not know it is unaffected.
CREATE TABLE IF NOT EXISTS "customer_erasures" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "client_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "erased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_erasures_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "customer_erasures_sequence_key" ON "customer_erasures"("sequence");
CREATE INDEX IF NOT EXISTS "customer_erasures_client_id_sequence_idx" ON "customer_erasures"("client_id", "sequence");
CREATE INDEX IF NOT EXISTS "customer_erasures_erased_at_idx" ON "customer_erasures"("erased_at");
