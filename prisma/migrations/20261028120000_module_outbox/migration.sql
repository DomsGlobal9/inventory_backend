-- Module outbox (28 Oct 2026): every change CRM (and later Finance) needs from Inventory, written by
-- the database itself in the same transaction as the change, so no code path can forget to send one.
--
-- New tables only, and the existing "DeliveryStatus" enum reused unchanged: nothing here adds an enum
-- value, so a deployed build that does not know these tables keeps working (the shared-DB enum hazard).

CREATE TABLE "module_subscriptions" (
    "client_id"  TEXT NOT NULL,
    "module"     TEXT NOT NULL,
    "enabled_by" TEXT,
    "enabled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "module_subscriptions_pkey" PRIMARY KEY ("client_id", "module")
);

CREATE TABLE "module_events" (
    "id"                   TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "sequence"             BIGSERIAL NOT NULL,
    "client_id"            TEXT NOT NULL,
    "module"               TEXT NOT NULL,
    "kind"                 TEXT NOT NULL,
    "source_table"         TEXT NOT NULL,
    "row_id"               TEXT NOT NULL,
    "payload"              JSONB NOT NULL,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status"               "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts"             INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at"      TIMESTAMP(3),
    "locked_at"            TIMESTAMP(3),
    "last_response_status" INTEGER,
    "last_error"           TEXT,
    "delivered_at"         TIMESTAMP(3),
    CONSTRAINT "module_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "module_events_sequence_key" ON "module_events"("sequence");
CREATE INDEX "module_events_status_next_attempt_at_idx" ON "module_events"("status", "next_attempt_at");
CREATE INDEX "module_events_module_client_id_sequence_idx" ON "module_events"("module", "client_id", "sequence");
CREATE INDEX "module_events_created_at_idx" ON "module_events"("created_at");

-- One function for every watched table. TG_ARGV[0] is the entity name used in the kind
-- ("customer" -> customer.created / customer.updated / customer.deleted). Line tables have no
-- client_id of their own and take it from their order or return.
CREATE OR REPLACE FUNCTION module_outbox_capture() RETURNS trigger AS $$
DECLARE
    r        jsonb;
    cid      text;
    sub      record;
    action   text;
BEGIN
    IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); action := 'deleted';
    ELSIF TG_OP = 'INSERT' THEN r := to_jsonb(NEW); action := 'created';
    ELSE r := to_jsonb(NEW); action := 'updated';
    END IF;

    IF TG_TABLE_NAME = 'sales_order_items' THEN
        SELECT client_id INTO cid FROM sales_orders WHERE id = r->>'sales_order_id';
    ELSIF TG_TABLE_NAME = 'sales_return_items' THEN
        SELECT client_id INTO cid FROM sales_returns WHERE id = r->>'sales_return_id';
    ELSE
        cid := r->>'client_id';
    END IF;
    IF cid IS NULL THEN RETURN NULL; END IF;

    FOR sub IN SELECT module FROM module_subscriptions WHERE client_id = cid LOOP
        INSERT INTO module_events (client_id, module, kind, source_table, row_id, payload)
        VALUES (cid, sub.module, TG_ARGV[0] || '.' || action, TG_TABLE_NAME, COALESCE(r->>'id', r->>'client_id', ''), r);
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- AFTER triggers: they see the committed shape of the row and roll back with it. Updates fire only
-- when something actually changed.
DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('customers', 'customer'),
        ('sales_orders', 'sale'),
        ('sales_order_items', 'sale_line'),
        ('sales_order_payments', 'payment'),
        ('dispatches', 'dispatch'),
        ('sales_returns', 'return'),
        ('sales_return_items', 'return_line'),
        ('loyalty_entries', 'points'),
        ('store_credit_entries', 'credit'),
        ('gift_vouchers', 'voucher'),
        ('gift_voucher_entries', 'voucher_entry'),
        ('store_checkins', 'checkin'),
        ('shop_product_views', 'product_view'),
        ('shop_interests', 'interest'),
        ('campaign_recipients', 'campaign_recipient'),
        -- One row per shop (no id): birthday/anniversary wishes on or off, so CRM's Today can say a wish goes.
        ('loyalty_settings', 'loyalty_settings')
    ) AS v(tbl, entity) LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_ins ON %I', t.tbl);
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_upd ON %I', t.tbl);
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_del ON %I', t.tbl);
        EXECUTE format('CREATE TRIGGER module_outbox_ins AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
        EXECUTE format('CREATE TRIGGER module_outbox_upd AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
        EXECUTE format('CREATE TRIGGER module_outbox_del AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
    END LOOP;
END $$;
