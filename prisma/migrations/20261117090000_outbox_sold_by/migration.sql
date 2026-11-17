-- 17 Nov 2026. CRM's change feed says how each sale and return line is sold.
--
-- Cloth is sold by the metre and its quantity is kept in centimetres (2.50 m = 250, price per cm), so a
-- sale_line of cloth reached CRM as "quantity 250, unit_price 4.50" with nothing to say it was cloth, and CRM
-- would show "250 x Rs 4.50". sale_line and return_line payloads now carry "sold_by" (PIECE, METRE, PACKET...):
-- METRE means quantity is centimetres and unit_price is per centimetre.
--
-- The function only: no table, column or enum changes, and the payload only GAINS a field, so a deployed build
-- and CRM as it is today keep working. Everything else is exactly the 20261028230000 version (Logistics still
-- gets no general change feed).
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
    END IF;
    IF cid IS NULL THEN RETURN NULL; END IF;

    FOR sub IN SELECT module FROM module_subscriptions WHERE client_id = cid AND module <> 'logistics' LOOP
        INSERT INTO module_events (client_id, module, kind, source_table, row_id, payload)
        VALUES (cid, sub.module, TG_ARGV[0] || '.' || action, TG_TABLE_NAME, COALESCE(r->>'id', r->>'client_id', ''), r);
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
