-- Give existing dispatches the date they went out.
--
-- `dispatched_at` is nullable, has no default, and nothing has ever written to it --
-- dispatch.service set status = 'SHIPPED' and left this empty. The day book selects the day's
-- sales with `where dispatchedAt between start and end`, so with every row null its entire
-- Sales section -- revenue, units dispatched, gross profit, the list of the day's orders -- has
-- read zero for every shop since it was written.
--
-- Measured before writing this: 0 of 14 dispatch rows across all tenants had a value.
--
-- created_at is the right value to use. createDispatch creates the record and ships it in one
-- transaction, so the moment it was written IS the moment the goods left; there is no case in
-- the data where a dispatch was prepared in advance, because nothing could prepare one.
--
-- Only rows that have actually shipped. A PENDING or CANCELLED dispatch has no departure date
-- and must not be given one, or the day book would count goods that never left.
UPDATE "dispatches"
SET "dispatched_at" = "created_at"
WHERE "dispatched_at" IS NULL
  AND "status" IN ('SHIPPED', 'DELIVERED');
