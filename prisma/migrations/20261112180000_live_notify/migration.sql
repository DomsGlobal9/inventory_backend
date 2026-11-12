-- Instant updates on every open screen (12 Nov 2026, PLAN-live.md). Any change to a table a screen shows -- by a
-- person, the POS till, CRM, Shopify or a background job -- sends "shop X: <topic> changed" on the channel
-- inventory_live. The server listens and tells that shop's open screens, which reload what they show through the
-- usual routes (so nothing private travels here, only the shop id and a topic word).
--
-- Postgres sends identical notifications of one transaction once, at commit, and none on rollback: a bill that
-- moves 50 stock lines says "stock changed" once, and a refused change says nothing. With nobody listening (an
-- older build) a notification is simply dropped.
CREATE OR REPLACE FUNCTION live_notify() RETURNS trigger AS $$
DECLARE
    cid text;
BEGIN
    IF TG_OP = 'DELETE' THEN cid := OLD.client_id; ELSE cid := NEW.client_id; END IF;
    IF cid IS NOT NULL THEN
        PERFORM pg_notify('inventory_live', json_build_object('c', cid, 't', TG_ARGV[0])::text);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('sales_orders', 'orders'),
        ('sales_order_payments', 'orders'),
        ('dispatches', 'orders'),
        ('sales_ledger', 'orders'),
        ('sales_returns', 'returns'),
        ('customers', 'customers'),
        ('loyalty_entries', 'customers'),
        ('gift_vouchers', 'vouchers'),
        ('inventory_stocks', 'stock'),
        ('inventory_transactions', 'stock'),
        ('inventory_transfers', 'stock'),
        ('spot_stocks', 'shelves'),
        ('storage_spots', 'shelves'),
        ('shelf_issues', 'shelves'),
        ('inventory_products', 'products'),
        ('inventory_product_variants', 'products'),
        ('inventory_alerts', 'alerts'),
        ('purchase_orders', 'purchases'),
        ('inventory_stock_counts', 'counts'),
        ('offers', 'offers')
    ) AS v(tbl, topic) LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS live_notify_%1$s ON %1$I', t.tbl);
        EXECUTE format('CREATE TRIGGER live_notify_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION live_notify(%2$L)', t.tbl, t.topic);
    END LOOP;
END $$;
