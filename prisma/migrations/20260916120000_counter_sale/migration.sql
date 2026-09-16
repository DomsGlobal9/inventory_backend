-- Selling at the counter: how the goods left, the money taken, the receipt footer, and the
-- permission to do it.
--
-- Everything here only ADDS. No existing row changes except that roles named ADMIN and SALES gain
-- one permission, the same way offer permissions reached existing shops on 13 Sep.

-- How a counter order leaves the shop. Null for every other order.
CREATE TYPE "SalesOrderHandover" AS ENUM ('TAKEN_NOW', 'KEEP_FOR_CUSTOMER');
ALTER TABLE "sales_orders" ADD COLUMN "handover" "SalesOrderHandover";

-- Money taken for an order, or paid back. One row per method.
CREATE TYPE "PaymentKind" AS ENUM ('PAYMENT', 'REFUND');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD');

CREATE TABLE "sales_order_payments" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sales_order_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL DEFAULT 'PAYMENT',
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "cash_received" DECIMAL(10,2),
    "change_given" DECIMAL(10,2),
    "reference" TEXT,
    "sales_return_id" TEXT,
    "received_by_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_payments_pkey" PRIMARY KEY ("id"),
    -- The rules the service applies, held by the database too, so no other write path can break them.
    CONSTRAINT "sales_order_payments_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "sales_order_payments_cash_only_change" CHECK (
      "method" = 'CASH' OR ("cash_received" IS NULL AND "change_given" IS NULL)
    ),
    CONSTRAINT "sales_order_payments_change_adds_up" CHECK (
      "cash_received" IS NULL OR ("change_given" IS NOT NULL AND "change_given" >= 0 AND "cash_received" = "amount" + "change_given")
    )
);

CREATE INDEX "sales_order_payments_client_id_received_at_idx" ON "sales_order_payments"("client_id", "received_at");
CREATE INDEX "sales_order_payments_sales_order_id_idx" ON "sales_order_payments"("sales_order_id");
CREATE INDEX "sales_order_payments_location_id_received_at_idx" ON "sales_order_payments"("location_id", "received_at");
CREATE INDEX "sales_order_payments_sales_return_id_idx" ON "sales_order_payments"("sales_return_id");
CREATE INDEX "sales_order_payments_received_by_id_idx" ON "sales_order_payments"("received_by_id");

ALTER TABLE "sales_order_payments" ADD CONSTRAINT "sales_order_payments_sales_order_id_fkey"
  FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_order_payments" ADD CONSTRAINT "sales_order_payments_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_payments" ADD CONSTRAINT "sales_order_payments_sales_return_id_fkey"
  FOREIGN KEY ("sales_return_id") REFERENCES "sales_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_order_payments" ADD CONSTRAINT "sales_order_payments_received_by_id_fkey"
  FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Printed at the bottom of a counter receipt.
ALTER TABLE "client_settings" ADD COLUMN "receipt_footer" TEXT;

-- Selling at the counter and taking payment, for the roles that sell.
INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'sales_order:counter_sale', 'Sell at the counter and take payment')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'sales_order:counter_sale'
WHERE r."name" IN ('ADMIN', 'SALES')
ON CONFLICT DO NOTHING;
