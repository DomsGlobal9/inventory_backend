-- 20 Nov 2026. CRM's parcel updates on WhatsApp (C10): a dispatch's change in the feed always carries the courier's NAME.
--
-- Logistics writes courier_name on the dispatch itself; a parcel sent the older way picked a courier from the shop's
-- list (courier_id) and left courier_name empty. For those, the name is filled in from shop_couriers, so one event has
-- everything the message needs (courier_name, tracking_number, tracking_url, status).
--
-- The function only: no table, column or enum changes, and the payload only GAINS a field. Everything else is exactly
-- the 20261117090000 version.
CREATE OR REPLACE FUNCTION module_outbox_capture() RETURNS trigger AS $$
DECLARE
    r        jsonb;
    cid      text;
    sub      record;
    action   text;
    unit     text;
BEGIN
    IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); action := 'deleted';
    ELSIF TG_OP = 'INSERT' THEN r := to_jsonb(NEW); action := 'created';
    ELSE r := to_jsonb(NEW); action := 'updated';
    END IF;

    IF TG_TABLE_NAME = 'sales_order_items' THEN
        SELECT client_id INTO cid FROM sales_orders WHERE id = r->>'sales_order_id';
        SELECT p.sold_by INTO unit
          FROM inventory_product_variants v JOIN inventory_products p ON p.id = v.product_id
         WHERE v.id = r->>'variant_id';
        r := r || jsonb_build_object('sold_by', COALESCE(unit, 'PIECE'));
    ELSIF TG_TABLE_NAME = 'sales_return_items' THEN
        SELECT client_id INTO cid FROM sales_returns WHERE id = r->>'sales_return_id';
        -- A return line names the sale line it takes back -- directly, or (when it is written before that link is
        -- filled in) through the dispatch line it came back from. The unit is that sale line's product's.
        SELECT p.sold_by INTO unit
          FROM sales_order_items i
          JOIN inventory_product_variants v ON v.id = i.variant_id
          JOIN inventory_products p ON p.id = v.product_id
         WHERE i.id = COALESCE(r->>'sales_order_item_id',
                               (SELECT di.sales_order_item_id FROM dispatch_items di WHERE di.id = r->>'dispatch_item_id'));
        r := r || jsonb_build_object('sold_by', COALESCE(unit, 'PIECE'));
    ELSE
        cid := r->>'client_id';
        IF TG_TABLE_NAME = 'dispatches' AND COALESCE(r->>'courier_name', '') = '' AND r->>'courier_id' IS NOT NULL THEN
            r := r || jsonb_build_object('courier_name', (SELECT name FROM shop_couriers WHERE id = r->>'courier_id'));
        END IF;
    END IF;
    IF cid IS NULL THEN RETURN NULL; END IF;

    FOR sub IN SELECT module FROM module_subscriptions WHERE client_id = cid AND module <> 'logistics' LOOP
        INSERT INTO module_events (client_id, module, kind, source_table, row_id, payload)
        VALUES (cid, sub.module, TG_ARGV[0] || '.' || action, TG_TABLE_NAME, COALESCE(r->>'id', r->>'client_id', ''), r);
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
