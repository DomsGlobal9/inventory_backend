-- 17 Nov 2026, after the audit. Small, safe steps only: a running older build keeps working through all of them.

-- 1. The boutique matching rows are Inventory's own business now (CRM shows nothing boutique), so they are no longer
--    announced on the module feed. They carried a person's name to every module that listens, for nobody to use.
DROP TRIGGER IF EXISTS module_outbox_ins ON "customer_boutique_profiles";
DROP TRIGGER IF EXISTS module_outbox_upd ON "customer_boutique_profiles";
DROP TRIGGER IF EXISTS module_outbox_del ON "customer_boutique_profiles";

-- 2. The number the boutique last sent for a person. When the shop corrects a customer's number in ScaleEzy and the
--    boutique sends the person again with its old number, they must stay on their customer instead of becoming a
--    second one: "did the boutique change the number?" needs the number it sent last time.
ALTER TABLE "customer_boutique_profiles" ADD COLUMN IF NOT EXISTS "sent_phone" TEXT;

-- A removed person keeps nothing personal: that number goes too. (snapshot / snapshot_at are still columns, unused
-- since 20261117170000; they are dropped in a later step, once no running build knows them.)
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
        NEW.sent_phone := NULL;
        NEW.customer_id := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Products saved with a blank kind, fabric, craft or brand ("" or spaces instead of nothing): the same as none.
--    New saves already store none (validations/product.schema.ts); these are the rows from before. A blank kind showed
--    as a pill with no words on a shop's page.
UPDATE "inventory_products" SET "dress_type" = NULL WHERE "dress_type" IS NOT NULL AND btrim("dress_type") = '';
UPDATE "inventory_products" SET "fabric" = NULL WHERE "fabric" IS NOT NULL AND btrim("fabric") = '';
UPDATE "inventory_products" SET "craft" = NULL WHERE "craft" IS NOT NULL AND btrim("craft") = '';
UPDATE "inventory_products" SET "brand" = NULL WHERE "brand" IS NOT NULL AND btrim("brand") = '';
