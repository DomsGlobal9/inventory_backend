-- 5 Nov 2026. Tells CRM once when an ONLINE order has arrived, so it can ask for a review with the order's own link
-- (GET /internal/modules/crm/shops/:clientId/orders/:salesOrderId/review-link). The link is a secret, so it is not in
-- the event. A trigger, like the rest of the outbox, because "delivered" is set from several places: Logistics, the
-- shop's own button, Shopify. Same rule as the customer's order page: nothing still on its way, nothing still to send.
-- It can never get in the way of marking a parcel delivered: anything going wrong here is only a warning.
CREATE OR REPLACE FUNCTION module_outbox_order_delivered() RETURNS trigger AS $$
DECLARE
    so   record;
    oo   record;
BEGIN
    BEGIN
        SELECT id, client_id, status, order_number, customer_name INTO so FROM sales_orders WHERE id = NEW.sales_order_id;
        IF so.id IS NULL OR so.status::text IN ('CANCELLED', 'PARTIALLY_DISPATCHED') THEN RETURN NULL; END IF;
        SELECT id, customer_phone INTO oo FROM online_shop_orders WHERE sales_order_id = so.id;
        IF oo.id IS NULL THEN RETURN NULL; END IF;     -- a till sale: no online order, no review link
        -- A parcel not cancelled and not delivered: still on its way. And at least one really arrived.
        IF EXISTS (SELECT 1 FROM dispatches WHERE sales_order_id = so.id AND status::text NOT IN ('DELIVERED', 'CANCELLED')) THEN RETURN NULL; END IF;
        IF NOT EXISTS (SELECT 1 FROM dispatches WHERE sales_order_id = so.id AND status::text = 'DELIVERED') THEN RETURN NULL; END IF;
        IF NOT EXISTS (SELECT 1 FROM online_shops WHERE client_id = so.client_id AND reviews AND accounts) THEN RETURN NULL; END IF;
        IF NOT EXISTS (SELECT 1 FROM module_subscriptions WHERE client_id = so.client_id AND module = 'crm') THEN RETURN NULL; END IF;
        -- Once per order, though a status can be set back and forward.
        IF EXISTS (SELECT 1 FROM module_events WHERE client_id = so.client_id AND module = 'crm' AND kind = 'order.delivered' AND row_id = so.id) THEN RETURN NULL; END IF;
        INSERT INTO module_events (client_id, module, kind, source_table, row_id, payload)
        VALUES (so.client_id, 'crm', 'order.delivered', 'sales_orders', so.id, jsonb_build_object(
            'sales_order_id', so.id, 'online_order_id', oo.id, 'client_id', so.client_id, 'order_number', so.order_number,
            'phone', oo.customer_phone, 'customer_name', so.customer_name, 'delivered_at', now()
        ));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'module_outbox_order_delivered: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS module_outbox_order_delivered ON dispatches;
CREATE TRIGGER module_outbox_order_delivered AFTER UPDATE OF status ON dispatches
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status::text IN ('DELIVERED', 'CANCELLED'))
    EXECUTE FUNCTION module_outbox_order_delivered();
