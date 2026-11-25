-- Gift voucher settings (on/off, smallest, largest) ride with the till's catalogue (giftVouchers in GET /pos/v1/catalogue),
-- and since 25 Nov 2026 a boutique can change them through the boutique API. Announce a change on the live line as
-- "settings", so the till hears it at once (pos-push), like the shop's other settings. Additive: a trigger only.
DROP TRIGGER IF EXISTS live_notify_gift_voucher_settings ON gift_voucher_settings;
CREATE TRIGGER live_notify_gift_voucher_settings AFTER INSERT OR UPDATE OR DELETE ON gift_voucher_settings
    FOR EACH ROW EXECUTE FUNCTION live_notify('settings');
