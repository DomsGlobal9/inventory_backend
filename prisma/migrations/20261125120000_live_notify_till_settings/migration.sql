-- Instant updates for what a POS till shows (25 Nov 2026, the owner: "everything instant between modules").
-- The live line (20261112180000_live_notify) never announced a shop's settings, its stores, loyalty rules, offer
-- codes, store prices or product photos, so a till only saw those on its next manual refresh. Additive: triggers only.

-- Tables keyed by the product or variant, not the shop: the shop is looked up from the product.
CREATE OR REPLACE FUNCTION live_notify_via_product() RETURNS trigger AS $$
DECLARE
    pid text;
    vid text;
    cid text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        pid := to_jsonb(OLD) ->> 'product_id'; vid := to_jsonb(OLD) ->> 'variant_id';
    ELSE
        pid := to_jsonb(NEW) ->> 'product_id'; vid := to_jsonb(NEW) ->> 'variant_id';
    END IF;
    IF pid IS NOT NULL THEN
        SELECT client_id INTO cid FROM inventory_products WHERE id = pid;
    ELSIF vid IS NOT NULL THEN
        SELECT client_id INTO cid FROM inventory_product_variants WHERE id = vid;
    END IF;
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
    -- Keyed by the shop: the existing live_notify().
    FOR t IN SELECT * FROM (VALUES
        ('client_settings', 'settings'),
        ('inventory_locations', 'settings'),
        ('loyalty_settings', 'settings'),
        ('offer_codes', 'offers')
    ) AS v(tbl, topic) LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS live_notify_%1$s ON %1$I', t.tbl);
        EXECUTE format('CREATE TRIGGER live_notify_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION live_notify(%2$L)', t.tbl, t.topic);
    END LOOP;
    -- Keyed by the product or variant.
    FOR t IN SELECT * FROM (VALUES
        ('variant_location_profiles', 'products'),
        ('inventory_product_images', 'products')
    ) AS v(tbl, topic) LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS live_notify_%1$s ON %1$I', t.tbl);
        EXECUTE format('CREATE TRIGGER live_notify_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION live_notify_via_product(%2$L)', t.tbl, t.topic);
    END LOOP;
END $$;
