-- Bank transfer and cheque, from the till once the money has arrived / the cheque cleared.
-- Deploy the code before any till sends them: an older build cannot read a row with a value it does not know.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'BANK_TRANSFER';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CHEQUE';
