-- Undo a payment recorded by mistake (services/order-payments): a second PAYMENT row for MINUS the amount
-- cancels the first, keyed UNDO:<payment id>. The rule that every amount is above zero (counter sale,
-- 16 Sep) stays for every other row; only such an undo row may be below zero.
-- One ALTER TABLE, so the old rule is never gone without the new one. Builds already deployed never write
-- a minus row, and everything that adds payments up already sums them, so they are unaffected.
ALTER TABLE "sales_order_payments"
  DROP CONSTRAINT IF EXISTS "sales_order_payments_amount_positive",
  ADD CONSTRAINT "sales_order_payments_amount_positive"
    CHECK ("amount" > 0 OR ("kind" = 'PAYMENT' AND "amount" < 0 AND "once_key" LIKE 'UNDO:%'));
