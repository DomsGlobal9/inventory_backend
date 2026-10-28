-- 28 Oct 2026. Packing for ScaleEzy Logistics. New tables and one new trigger function only: no enum,
-- no change to an existing column.
--
-- shipping_boxes:     a shop's box sizes (Small / Medium / Large by default).
-- logistics_parcels:  a parcel packed and weighed, made together with its dispatch. A new row goes to
--                     Logistics as parcel.ready (its payload), for shops that switched Logistics on.
--                     Logistics is left out of the general change feed (20261028230000); this is the
--                     only thing it is sent.
CREATE TABLE IF NOT EXISTS "shipping_boxes" (
    "id"         TEXT NOT NULL,
    "client_id"  TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "length_cm"  DECIMAL(6,1) NOT NULL,
    "breadth_cm" DECIMAL(6,1) NOT NULL,
    "height_cm"  DECIMAL(6,1) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipping_boxes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "shipping_boxes_client_id_name_key" ON "shipping_boxes"("client_id", "name");

CREATE TABLE IF NOT EXISTS "logistics_parcels" (
    "id"             TEXT NOT NULL,
    "client_id"      TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "dispatch_id"    TEXT NOT NULL,
    "location_id"    TEXT NOT NULL,
    "box_name"       TEXT,
    "length_cm"      DECIMAL(6,1) NOT NULL,
    "breadth_cm"     DECIMAL(6,1) NOT NULL,
    "height_cm"      DECIMAL(6,1) NOT NULL,
    "weight_grams"   INTEGER NOT NULL,
    "packed_by_id"   TEXT,
    "packed_by_name" TEXT,
    "packed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload"        JSONB NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'READY',
    "courier_name"   TEXT,
    "awb"            TEXT,
    "tracking_url"   TEXT,
    "label_url"      TEXT,
    "cod_collected"  DECIMAL(10,2),
    "last_status_at" TIMESTAMP(3),
    "history"        JSONB NOT NULL DEFAULT '[]',
    "updated_at"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "logistics_parcels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "logistics_parcels_dispatch_id_key" ON "logistics_parcels"("dispatch_id");
CREATE INDEX IF NOT EXISTS "logistics_parcels_client_id_sales_order_id_idx" ON "logistics_parcels"("client_id", "sales_order_id");
CREATE INDEX IF NOT EXISTS "logistics_parcels_client_id_status_idx" ON "logistics_parcels"("client_id", "status");

CREATE OR REPLACE FUNCTION logistics_parcel_capture() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM module_subscriptions WHERE client_id = NEW.client_id AND module = 'logistics') THEN
        INSERT INTO module_events (client_id, module, kind, source_table, row_id, payload)
        VALUES (NEW.client_id, 'logistics', 'parcel.ready', 'logistics_parcels', NEW.id, NEW.payload);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS logistics_parcel_ready ON "logistics_parcels";
CREATE TRIGGER logistics_parcel_ready AFTER INSERT ON "logistics_parcels" FOR EACH ROW EXECUTE FUNCTION logistics_parcel_capture();
