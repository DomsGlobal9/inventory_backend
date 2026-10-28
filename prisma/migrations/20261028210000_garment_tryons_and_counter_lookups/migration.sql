-- 28 Oct 2026. New tables only: no enum, no change to an existing column.
--
-- 1. garment_tryon_days: how often each garment and colour was tried on by shoppers, as daily totals
--    per place (TAG / SHOP_PAGE / COUNTER). No customer and no photograph: the owner asked for counts,
--    not who.
-- 2. counter_lookups: each Customer card look-up at the counter, so CRM gets the counter history.
--    Into the module outbox with the SAME capture function as 20261028120000_module_outbox
--    (kind counter_lookup.created), so only shops on CRM produce events.
CREATE TABLE IF NOT EXISTS "garment_tryon_days" (
    "client_id"  TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "colour"     TEXT NOT NULL DEFAULT '',
    "day"        DATE NOT NULL,
    "place"      TEXT NOT NULL,
    "completed"  INTEGER NOT NULL DEFAULT 0,
    "failed"     INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "garment_tryon_days_pkey" PRIMARY KEY ("client_id", "product_id", "colour", "day", "place")
);
CREATE INDEX IF NOT EXISTS "garment_tryon_days_client_id_day_idx" ON "garment_tryon_days"("client_id", "day");

CREATE TABLE IF NOT EXISTS "counter_lookups" (
    "id"            TEXT NOT NULL,
    "client_id"     TEXT NOT NULL,
    "location_id"   TEXT,
    "customer_id"   TEXT NOT NULL,
    "user_id"       TEXT,
    "user_name"     TEXT,
    "picks"         JSONB NOT NULL DEFAULT '[]',
    "also_bought"   JSONB NOT NULL DEFAULT '[]',
    "looked_online" JSONB NOT NULL DEFAULT '[]',
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "counter_lookups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "counter_lookups_client_id_customer_id_created_at_idx" ON "counter_lookups"("client_id", "customer_id", "created_at");

DROP TRIGGER IF EXISTS module_outbox_ins ON "counter_lookups";
CREATE TRIGGER module_outbox_ins AFTER INSERT ON "counter_lookups" FOR EACH ROW EXECUTE FUNCTION module_outbox_capture('counter_lookup');
