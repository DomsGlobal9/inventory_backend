-- Live updates, step 3 (12 Nov 2026, PLAN-live.md): two more change signals on the channel inventory_live.
--   client_settings   -> 'settings'  (GST, the manual-discount limit, branding: the till's catalogue carries them,
--                                     and open Settings screens reload)
--   customer_erasures -> 'erasures'  (heard by the server only: it sends the till its customer.erased events at
--                                     once instead of on the next 5-second pass)
-- Reuses live_notify() from 20261112180000_live_notify. Safe to run again.
DROP TRIGGER IF EXISTS live_notify_client_settings ON client_settings;
CREATE TRIGGER live_notify_client_settings AFTER INSERT OR UPDATE OR DELETE ON client_settings
    FOR EACH ROW EXECUTE FUNCTION live_notify('settings');

DROP TRIGGER IF EXISTS live_notify_customer_erasures ON customer_erasures;
CREATE TRIGGER live_notify_customer_erasures AFTER INSERT ON customer_erasures
    FOR EACH ROW EXECUTE FUNCTION live_notify('erasures');
