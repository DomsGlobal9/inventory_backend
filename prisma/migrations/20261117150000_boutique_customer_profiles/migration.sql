-- The boutique app's (CRM-B) people in ScaleEzy (17 Nov 2026, agreed with the CRM chat; owner: "one person, one record").
--
-- One row per BOUTIQUE person, pointing at the Inventory customer who holds their phone number. Several boutique
-- people can point at one customer (a mother and daughter on one phone): their measurements stay in separate rows,
-- never merged. The snapshot (measurement sets and a small stitching summary) is CRM-B's, stored as sent and shown
-- read-only by CRM, which hears every change on the module feed (customer_boutique_profile.created|updated|deleted).
--
-- When the Inventory customer goes (deleted, erased, an import taken back), the row is kept as a marker with NO
-- personal data -- name and snapshot wiped, removed = true -- so CRM and CRM-B both learn to wipe their copies.
-- A new table only: nothing a running server reads changes.
CREATE TABLE IF NOT EXISTS "customer_boutique_profiles" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "boutique_customer_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "boutique_name" TEXT,
    "name_matches" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "snapshot_at" TIMESTAMP(3),
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "removed_reason" TEXT,
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_boutique_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "customer_boutique_profiles_client_id_boutique_customer_id_key" ON "customer_boutique_profiles" ("client_id", "boutique_customer_id");
CREATE INDEX IF NOT EXISTS "customer_boutique_profiles_client_id_customer_id_idx" ON "customer_boutique_profiles" ("client_id", "customer_id");
CREATE INDEX IF NOT EXISTS "customer_boutique_profiles_client_id_removed_at_idx" ON "customer_boutique_profiles" ("client_id", "removed_at");

DO $$ BEGIN
    ALTER TABLE "customer_boutique_profiles" ADD CONSTRAINT "customer_boutique_profiles_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The customer was deleted (the key above set customer_id to null) or erased (the app sets it to null): whatever the
-- path, the row keeps nothing personal from that moment on.
CREATE OR REPLACE FUNCTION customer_boutique_profile_gone() RETURNS trigger AS $$
BEGIN
    IF NEW.customer_id IS NULL AND OLD.customer_id IS NOT NULL AND NOT OLD.removed THEN
        NEW.removed := true;
        NEW.removed_reason := COALESCE(NEW.removed_reason, 'CUSTOMER_REMOVED');
        NEW.removed_at := COALESCE(NEW.removed_at, CURRENT_TIMESTAMP);
    END IF;
    IF NEW.removed THEN
        NEW.boutique_name := NULL;
        NEW.name_matches := false;
        NEW.snapshot := '{}'::jsonb;
        NEW.snapshot_at := NULL;
        NEW.customer_id := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_boutique_profile_gone ON "customer_boutique_profiles";
CREATE TRIGGER customer_boutique_profile_gone BEFORE UPDATE ON "customer_boutique_profiles"
    FOR EACH ROW EXECUTE FUNCTION customer_boutique_profile_gone();

-- CRM hears every change, like every other customer table.
DROP TRIGGER IF EXISTS module_outbox_ins ON "customer_boutique_profiles";
DROP TRIGGER IF EXISTS module_outbox_upd ON "customer_boutique_profiles";
DROP TRIGGER IF EXISTS module_outbox_del ON "customer_boutique_profiles";
CREATE TRIGGER module_outbox_ins AFTER INSERT ON "customer_boutique_profiles" FOR EACH ROW EXECUTE FUNCTION module_outbox_capture('customer_boutique_profile');
CREATE TRIGGER module_outbox_upd AFTER UPDATE ON "customer_boutique_profiles" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION module_outbox_capture('customer_boutique_profile');
CREATE TRIGGER module_outbox_del AFTER DELETE ON "customer_boutique_profiles" FOR EACH ROW EXECUTE FUNCTION module_outbox_capture('customer_boutique_profile');

-- An erase keeps the customer row (deleted_at set, details emptied), so the key above does not fire. Whatever marks a
-- customer deleted -- the owner's delete, a Shopify privacy request, anything -- detaches their boutique people here,
-- and the trigger above wipes them.
CREATE OR REPLACE FUNCTION customer_gone_detach_boutique() RETURNS trigger AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE customer_boutique_profiles SET customer_id = NULL WHERE customer_id = NEW.id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_gone_detach_boutique ON "customers";
CREATE TRIGGER customer_gone_detach_boutique AFTER UPDATE OF deleted_at ON "customers"
    FOR EACH ROW EXECUTE FUNCTION customer_gone_detach_boutique();
