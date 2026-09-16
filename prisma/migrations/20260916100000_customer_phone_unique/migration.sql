-- One customer per phone number, per shop.
--
-- A counter finds its customers by phone. Numbers were stored as typed, so "98480 22338",
-- "09848022338" and "+91-98480-22338" were three customers for one person, and nothing stopped a
-- second customer being saved on a number already taken. From here every number is stored one way
-- (E.164, "+919848022338" -- the same rule as backend/src/lib/phone.ts) and a unique index holds it.
--
--   1. Blank numbers become NULL; every stored number is rewritten in the one form where it can be.
--      A value that is not a number at all is left as it was, for a person to correct.
--   2. If any shop still has two live customers on one number, this stops and names them. It never
--      merges or deletes customers by itself: which of the two is the real one is a person's call.
--   3. The unique index, for live customers that have a number. Customers without one -- Shopify
--      guests, and an online customer whose number was already taken -- are allowed.

-- @norm-begin
CREATE OR REPLACE FUNCTION pg_temp.scaleezy_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN p IS NULL OR btrim(p) = '' THEN NULL
    WHEN c !~ '^([+]|00)?[0-9]+$' THEN p
    WHEN NOT intl AND d ~ '^[6-9][0-9]{9}$' THEN '+91' || d
    WHEN NOT intl AND d ~ '^0[6-9][0-9]{9}$' THEN '+91' || substr(d, 2)
    WHEN d ~ '^91[6-9][0-9]{9}$' THEN '+' || d
    WHEN intl AND d !~ '^91' AND d ~ '^[1-9][0-9]{7,14}$' THEN '+' || d
    ELSE p
  END
  FROM (SELECT c, c ~ '^([+]|00)' AS intl, regexp_replace(c, '^([+]|00)', '') AS d
        FROM (SELECT regexp_replace(coalesce(p, ''), '[[:space:]().-]', '', 'g') AS c) x) y
$fn$;
-- @norm-end

UPDATE "customers"
SET "phone" = pg_temp.scaleezy_phone("phone")
WHERE "phone" IS DISTINCT FROM pg_temp.scaleezy_phone("phone");

DO $stop$
DECLARE
  clash text;
BEGIN
  SELECT string_agg(format('%s: %s (%s customers)', client_id, phone, n), '; ')
  INTO clash
  FROM (
    SELECT client_id, phone, COUNT(*) AS n
    FROM "customers"
    WHERE phone IS NOT NULL AND deleted_at IS NULL
    GROUP BY client_id, phone
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 20
  ) d;

  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'Some shops have more than one customer on the same phone number. Decide which customer keeps each number, change or clear the others, then run this again. %', clash;
  END IF;
END
$stop$;

CREATE UNIQUE INDEX "customers_client_id_phone_live_key"
  ON "customers" ("client_id", "phone")
  WHERE "phone" IS NOT NULL AND "deleted_at" IS NULL;
