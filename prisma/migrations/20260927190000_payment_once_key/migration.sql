-- Money collected after the sale reaches us as its own event, retried on a timeout like any
-- other. Without a key, a retry records the payment twice and the books say a customer paid
-- twice with nothing in the rows to say which was real.
--
-- Additive and nullable: every payment written by a person at a counter leaves it null, and the
-- deployed build never selects it.
ALTER TABLE "sales_order_payments" ADD COLUMN "once_key" TEXT;

CREATE UNIQUE INDEX "sales_order_payments_once_key_key" ON "sales_order_payments"("once_key");
