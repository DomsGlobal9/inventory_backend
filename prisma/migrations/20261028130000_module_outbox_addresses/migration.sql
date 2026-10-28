-- Customer addresses into the module outbox (28 Oct 2026). CRM noticed an address change reached it
-- only with the customer's next other change. Same capture function as 20261028120000_module_outbox;
-- kinds customer_address.created / .updated / .deleted. Triggers only: no table, no enum change.
DROP TRIGGER IF EXISTS module_outbox_ins ON customer_addresses;
DROP TRIGGER IF EXISTS module_outbox_upd ON customer_addresses;
DROP TRIGGER IF EXISTS module_outbox_del ON customer_addresses;
CREATE TRIGGER module_outbox_ins AFTER INSERT ON customer_addresses FOR EACH ROW EXECUTE FUNCTION module_outbox_capture('customer_address');
CREATE TRIGGER module_outbox_upd AFTER UPDATE ON customer_addresses FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION module_outbox_capture('customer_address');
CREATE TRIGGER module_outbox_del AFTER DELETE ON customer_addresses FOR EACH ROW EXECUTE FUNCTION module_outbox_capture('customer_address');
