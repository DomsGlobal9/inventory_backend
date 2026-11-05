-- Customer reviews and private feedback on the online shop (5 Nov 2026). Text columns rather than enums: a new enum
-- value in this shared database breaks a deployed build that reads it.

CREATE TABLE "shop_reviews" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "online_order_id" TEXT,
    "variant_code" TEXT,
    "variant_label" TEXT,
    "phone" TEXT NOT NULL,
    "customer_name" TEXT,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photos" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "hidden_reason" TEXT,
    "hidden_at" TIMESTAMP(3),
    "hidden_by" TEXT,
    "reply" TEXT,
    "reply_at" TIMESTAMP(3),
    "reply_by" TEXT,
    "edited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shop_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shop_reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5),
    CONSTRAINT "shop_reviews_status_known" CHECK ("status" IN ('PUBLISHED', 'HIDDEN'))
);
CREATE UNIQUE INDEX "shop_reviews_product_id_phone_key" ON "shop_reviews"("product_id", "phone");
CREATE INDEX "shop_reviews_product_id_status_created_at_idx" ON "shop_reviews"("product_id", "status", "created_at");
CREATE INDEX "shop_reviews_client_id_status_created_at_idx" ON "shop_reviews"("client_id", "status", "created_at");
CREATE INDEX "shop_reviews_client_id_phone_idx" ON "shop_reviews"("client_id", "phone");
ALTER TABLE "shop_reviews" ADD CONSTRAINT "shop_reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "shop_order_feedback" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "online_order_id" TEXT NOT NULL,
    "order_number" TEXT,
    "phone" TEXT,
    "customer_name" TEXT,
    "body" TEXT NOT NULL,
    "handled_at" TIMESTAMP(3),
    "handled_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shop_order_feedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shop_order_feedback_online_order_id_key" ON "shop_order_feedback"("online_order_id");
CREATE INDEX "shop_order_feedback_client_id_created_at_idx" ON "shop_order_feedback"("client_id", "created_at");
CREATE INDEX "shop_order_feedback_client_id_phone_idx" ON "shop_order_feedback"("client_id", "phone");
ALTER TABLE "shop_order_feedback" ADD CONSTRAINT "shop_order_feedback_online_order_id_fkey" FOREIGN KEY ("online_order_id") REFERENCES "online_shop_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A shop can switch reviews off, as it can its wishlist.
ALTER TABLE "online_shops" ADD COLUMN "reviews" BOOLEAN NOT NULL DEFAULT true;

-- CRM hears of each one through the module outbox (20261028120000_module_outbox), as review.* and feedback.*.
DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES ('shop_reviews', 'review'), ('shop_order_feedback', 'feedback')) AS v(tbl, entity) LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_ins ON %I', t.tbl);
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_upd ON %I', t.tbl);
        EXECUTE format('DROP TRIGGER IF EXISTS module_outbox_del ON %I', t.tbl);
        EXECUTE format('CREATE TRIGGER module_outbox_ins AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
        EXECUTE format('CREATE TRIGGER module_outbox_upd AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
        EXECUTE format('CREATE TRIGGER module_outbox_del AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION module_outbox_capture(%L)', t.tbl, t.entity);
    END LOOP;
END $$;
