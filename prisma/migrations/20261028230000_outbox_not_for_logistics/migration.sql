-- 28 Oct 2026. Logistics is a module a shop switches on (module_subscriptions, like CRM), but it must
-- NOT receive the general change feed -- customers, sales, campaigns -- that CRM does. It gets only its
-- own parcel events, written by their own trigger later.
--
-- So the shared capture function skips 'logistics' subscriptions. Otherwise identical to
-- 20261028120000_module_outbox. Function only: no table, no column, no enum.
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

    FOR sub IN SELECT module FROM module_subscriptions WHERE client_id = cid AND module <> 'logistics' LOOP
        INSERT INTO module_events (client_id, module, kind, source_table, row_id, payload)
        VALUES (cid, sub.module, TG_ARGV[0] || '.' || action, TG_TABLE_NAME, COALESCE(r->>'id', r->>'client_id', ''), r);
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
