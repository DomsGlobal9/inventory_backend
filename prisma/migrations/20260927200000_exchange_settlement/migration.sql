-- An exchange settles the new bill against the credit note for what came back.
--
-- It has to be recorded or the order looks unpaid and the shop chases a customer who owes
-- nothing. It must NOT be recorded as cash, or the owner's Day Book shows money that never
-- existed and cannot be found in the bank. So: a row that makes the bill paid, naming the return
-- it settles, and excluded from every figure that means money.
--
-- Additive and nullable. Null on every ordinary payment, and the deployed build never selects it.
ALTER TABLE "sales_order_payments" ADD COLUMN "settles_return_id" TEXT;

ALTER TABLE "sales_order_payments"
  ADD CONSTRAINT "sales_order_payments_settles_return_id_fkey"
  FOREIGN KEY ("settles_return_id") REFERENCES "sales_returns"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "sales_order_payments_settles_return_id_idx" ON "sales_order_payments"("settles_return_id");
