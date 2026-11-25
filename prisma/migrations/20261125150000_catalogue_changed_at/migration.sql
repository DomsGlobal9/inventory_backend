-- The catalogue sync feed's clock (25 Nov 2026, found by the POS session in a joint test).
--
-- The storefront/till feed (GET /pos/v1/catalogue, the storefront sync feed) paged and answered "changed since" on
-- inventory_products.updated_at. That moves only when the PRODUCT row is written, so a size's price, a sale or any
-- stock movement, a store price, a photo or a reservation never reached a till's quick (cursor) pull: the push
-- arrived at once, the pull brought nothing, and the till showed the old price or stock until its 30-minute full pull.
--
-- Now every product carries catalogue_changed_at, set ONLY here, by triggers:
--   * the product itself written                          -> stamped in the same statement
--   * its sizes, stock, store prices, photos, reservations -> stamped AT COMMIT (deferred), so the stamp is as close as
--                                                            possible to the moment the change becomes visible, and the
--                                                            product row is locked only for that instant
-- One commit touching 500 stock rows of one product stamps it once (a per-transaction mark).
-- Times are UTC without zone, like every Prisma DateTime here.
-- Every product is stamped now, so each till's next quick pull brings its whole catalogue once and heals anything
-- missed so far.

ALTER TABLE "inventory_products" ADD COLUMN "catalogue_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "inventory_products_client_id_catalogue_changed_at_id_idx" ON "inventory_products"("client_id", "catalogue_changed_at", "id");

-- The product itself.
CREATE OR REPLACE FUNCTION catalogue_stamp_product() RETURNS trigger AS $$
BEGIN
    NEW.catalogue_changed_at := (clock_timestamp() AT TIME ZONE 'UTC');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS catalogue_stamp_product ON "inventory_products";
CREATE TRIGGER catalogue_stamp_product BEFORE INSERT OR UPDATE ON "inventory_products"
    FOR EACH ROW EXECUTE FUNCTION catalogue_stamp_product();

-- Something shown with the product: find the product (by product_id, else by variant_id) and stamp it at commit.
CREATE OR REPLACE FUNCTION catalogue_touch_product() RETURNS trigger AS $$
DECLARE
    r    jsonb;
    pid  text;
    vid  text;
    mark timestamp;
BEGIN
    IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
    pid := r ->> 'product_id';
    vid := r ->> 'variant_id';
    IF pid IS NULL AND vid IS NOT NULL THEN
        SELECT product_id INTO pid FROM inventory_product_variants WHERE id = vid;
    END IF;
    IF pid IS NULL THEN RETURN NULL; END IF;

    -- This transaction's commit mark: a product stamped at or after it was already stamped by this commit.
    mark := NULLIF(current_setting('scaleezy.catalogue_mark', true), '')::timestamp;
    IF mark IS NULL THEN
        mark := (clock_timestamp() AT TIME ZONE 'UTC');
        PERFORM set_config('scaleezy.catalogue_mark', mark::text, true);
    END IF;
    UPDATE inventory_products SET catalogue_changed_at = (clock_timestamp() AT TIME ZONE 'UTC')
     WHERE id = pid AND catalogue_changed_at < mark;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['inventory_product_variants', 'inventory_stocks', 'variant_location_profiles',
                             'inventory_product_images', 'inventory_reservations'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS catalogue_touch_ins_del ON %I', t);
        EXECUTE format('DROP TRIGGER IF EXISTS catalogue_touch_upd ON %I', t);
        EXECUTE format('CREATE CONSTRAINT TRIGGER catalogue_touch_ins_del AFTER INSERT OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalogue_touch_product()', t);
        EXECUTE format('CREATE CONSTRAINT TRIGGER catalogue_touch_upd AFTER UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION catalogue_touch_product()', t);
    END LOOP;
END $$;
