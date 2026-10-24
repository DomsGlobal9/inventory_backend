-- Fix to 20261023180000: a minus payment with NO once_key passed, because `NULL LIKE 'UNDO:%'` is NULL,
-- and a CHECK refuses only FALSE (verify-order-payments caught it, 24 Oct). The key must now be there.
-- Still only an undo row (PAYMENT, minus, keyed UNDO:<payment id>) may be below zero.
ALTER TABLE "sales_order_payments"
  DROP CONSTRAINT IF EXISTS "sales_order_payments_amount_positive",
  ADD CONSTRAINT "sales_order_payments_amount_positive"
    CHECK ("amount" > 0 OR ("kind" = 'PAYMENT' AND "amount" < 0 AND "once_key" IS NOT NULL AND "once_key" LIKE 'UNDO:%'));
