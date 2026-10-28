-- Hand-over to CRM (28 Oct 2026, PLAN-crm.md §7).
--
-- 1. module_subscriptions.moved: per shop, which customer features CRM now runs instead of Inventory.
--    { notes?, onlineViews?, card?, groups?, campaigns?: bool, wishes?: { fromDay: "YYYY-MM-DD" } | null }.
--    Null = nothing has moved. Set through PUT /api/v1/internal/modules/crm/shops/:clientId/moved, which
--    keeps the safety rules (services/crm-handover). New nullable column only.
--
-- 2. Customer groups, campaigns, campaign templates and campaign pictures into the module outbox, with
--    the SAME capture function as 20261028120000_module_outbox (every one of these tables has its own
--    client_id and id). Triggers only: no table, no enum change.
ALTER TABLE "module_subscriptions" ADD COLUMN IF NOT EXISTS "moved" JSONB;

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('customer_groups', 'customer_group'),
        ('campaigns', 'campaign'),
        ('campaign_templates', 'campaign_template'),
        ('campaign_media', 'campaign_media')
    ) AS v(tbl, entity) LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_ins ON %I', t.tbl);
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_upd ON %I', t.tbl);
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_del ON %I', t.tbl);
        EXECUTE format('CREATE TRIGGER module_outbox_ins AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
        EXECUTE format('CREATE TRIGGER module_outbox_upd AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
        EXECUTE format('CREATE TRIGGER module_outbox_del AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
    END LOOP;
END $$;
