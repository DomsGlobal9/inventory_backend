-- Who received the goods, as typed at the door, separate from whose login recorded it.
--
-- received_by_name was the signed-in account's name. The person who signs for a delivery is often
-- not the person entering it into the app -- a stock-room helper takes the boxes, the manager types
-- them in later -- and the receipt handed to the supplier has to name the one who took them.
--
--   received_by_name   the receiver, typed when receiving (printed on the receipt)
--   received_by_phone  their phone, optional (printed on the receipt)
--   recorded_by_name   the account that pressed Confirm Receipt (kept for the record, not printed)
--
-- Receipts made before this change named the account, which was also the only receiver anyone had
-- recorded, so that name is copied into recorded_by_name and left where it is.
ALTER TABLE "purchase_receipts" ADD COLUMN "received_by_phone" TEXT;
ALTER TABLE "purchase_receipts" ADD COLUMN "recorded_by_name" TEXT;

UPDATE "purchase_receipts" SET "recorded_by_name" = "received_by_name" WHERE "recorded_by_name" IS NULL;
