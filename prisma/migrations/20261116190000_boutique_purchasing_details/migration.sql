-- The boutique's (CRM-B) supplier and purchase-order details. All optional, written only by the boutique API;
-- retail shops never set them. payment_status is TEXT, not an enum (see the shared-database enum note).
ALTER TABLE "suppliers" ADD COLUMN "contact_person" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "gstin" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "notes" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "invoice_number" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "tax_amount" DECIMAL(12,2);
ALTER TABLE "purchase_orders" ADD COLUMN "payment_status" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "batch_number" TEXT;
