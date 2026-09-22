-- CreateEnum
CREATE TYPE "StoreCreditKind" AS ENUM ('FROM_RETURN', 'USED', 'PAID_OUT', 'ADJUSTED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'CREDIT';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "store_credit_paise" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales_returns" ADD COLUMN     "at_counter" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "counter_key" TEXT,
ADD COLUMN     "location_id" TEXT,
ADD COLUMN     "refund_method" TEXT,
ADD COLUMN     "refunded_at" TIMESTAMP(3),
ADD COLUMN     "refunded_by_id" TEXT;

-- AlterTable
ALTER TABLE "client_settings" ADD COLUMN     "counter_return_max" DECIMAL(12,2),
ADD COLUMN     "return_window_days" INTEGER;

-- CreateTable
CREATE TABLE "store_credit_entries" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "kind" "StoreCreditKind" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "balance_paise" INTEGER NOT NULL,
    "sales_order_id" TEXT,
    "sales_return_id" TEXT,
    "note" TEXT,
    "created_by_id" TEXT,
    "once_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_credit_entries_once_key_key" ON "store_credit_entries"("once_key");

-- CreateIndex
CREATE INDEX "store_credit_entries_client_id_customer_id_created_at_idx" ON "store_credit_entries"("client_id", "customer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_counter_key_key" ON "sales_returns"("counter_key");

-- AddForeignKey
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The counter's new permission, and every shop's built-in SALES and ADMIN roles given it: until now
-- a salesperson could not take anything back at the till at all.
INSERT INTO "permissions" ("id", "key", "description")
VALUES (gen_random_uuid()::text, 'return:counter', 'Take a return back at the counter and pay the money back')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
 WHERE r."name" IN ('SALES', 'ADMIN') AND p."key" = 'return:counter'
ON CONFLICT DO NOTHING;
