-- Who rang up a sales order. Null for orders a system wrote (Shopify) and for every order before
-- this; kept (set null) if the person is removed.
ALTER TABLE "sales_orders" ADD COLUMN "created_by_id" TEXT;

CREATE INDEX "sales_orders_created_by_id_idx" ON "sales_orders"("created_by_id");

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
