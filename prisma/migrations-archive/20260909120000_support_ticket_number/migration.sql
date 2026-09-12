-- A support ticket needs a reference a person can say out loud.
--
-- Tickets were identified only by a UUID, so a customer writing back had nothing to quote but
-- 36 characters of hex, and support staff had nothing short to search for. Every other entity
-- in this product already has a human code -- PRD-000001, VAR-000001, TRF-000004 -- generated
-- by the same race-safe sequence table. Tickets were the omission.

-- Nullable first, so existing rows are not rejected while they are being filled in.
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "ticket_number" TEXT;

-- Backfill in creation order, per client, so the numbering reads as a history rather than as
-- whatever order the rows happen to come back in. 23 tickets across 21 clients at the time of
-- writing, so this is cheap; it is written to stay correct if that grows.
WITH numbered AS (
  SELECT id,
         client_id,
         'TCK-' || LPAD(ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY created_at, id)::text, 6, '0') AS n
  FROM "support_tickets"
)
UPDATE "support_tickets" t
SET "ticket_number" = numbered.n
FROM numbered
WHERE t.id = numbered.id AND t."ticket_number" IS NULL;

-- The sequence table must agree with what was just handed out, or the next ticket for an
-- existing client would collide with a backfilled one.
INSERT INTO "inventory_client_sequences" ("id", "client_id", "entity_type", "last_value")
SELECT gen_random_uuid(), client_id, 'SUPPORT_TICKET', COUNT(*)
FROM "support_tickets"
GROUP BY client_id
ON CONFLICT ("client_id", "entity_type") DO UPDATE
SET "last_value" = GREATEST("inventory_client_sequences"."last_value", EXCLUDED."last_value");

-- Unique per client, matching how every other code in this schema is scoped. Not globally
-- unique: two shops each having a TCK-000001 is correct, and a global counter would leak how
-- many tickets the whole platform has to anyone who raises one.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_support_ticket_number"
  ON "support_tickets" ("client_id", "ticket_number");
