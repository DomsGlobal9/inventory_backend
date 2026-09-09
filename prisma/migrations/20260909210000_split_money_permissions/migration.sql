-- Split the money permissions out of dashboard:view, and quantity authority out of monetary.
--
-- Before this, `dashboard:view` guarded sixteen routes including inventory value, supplier
-- spend, dead stock value and the day book -- and every seeded role held it, including SALES.
-- A shop-floor salesperson could read the shop's profit and what it pays its suppliers.
--
-- This transforms today's grants into explicit new ones. It deliberately does NOT leave the
-- authorisation system reading role NAMES: after this runs, every role holds the keys it needs
-- as ordinary rows, and nothing anywhere says `if role === 'ADMIN'`. Names are used here, once,
-- to decide the mapping -- and never again.

-- ── 1. The new keys ─────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid(), 'cost:view',          'See what the business paid for its stock'),
  (gen_random_uuid(), 'cost:manage',        'Set and restate what stock cost'),
  (gen_random_uuid(), 'report:view',        'See operational reports'),
  (gen_random_uuid(), 'report:financial',   'See money reports'),
  (gen_random_uuid(), 'tryon:generate',     'Generate try-on images'),
  (gen_random_uuid(), 'team:view_password', 'Read a team member''s password')
ON CONFLICT ("key") DO NOTHING;

-- ── 2. Everyone who could see the dashboard keeps it, and gains report:view ──
-- Operational reports are what the old key was meant to be. Nobody loses anything they were
-- using for their job.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", (SELECT "id" FROM "permissions" WHERE "key" = 'report:view')
FROM "role_permissions" rp
JOIN "permissions" p ON p."id" = rp."permission_id"
WHERE p."key" = 'dashboard:view'
ON CONFLICT DO NOTHING;

-- ── 3. Only the roles that were meant to see money, do ──────────────────────
-- ADMIN, INVENTORY_MANAGER and SUPER_ADMIN. Named here once, to decide the mapping; from this
-- point the grants are rows like any other and a shop can change them.
--
-- SALES and WAREHOUSE are deliberately absent. This is the line where a live shop's
-- salesperson stops being able to read the shop's profit, which is the point of the exercise
-- and worth telling those shops about.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", (SELECT "id" FROM "permissions" WHERE "key" = 'report:financial')
FROM "roles" r
WHERE r."name" IN ('ADMIN', 'INVENTORY_MANAGER', 'SUPER_ADMIN')
ON CONFLICT DO NOTHING;

-- report:financial implies cost:view in the catalogue, so it is not stored. Roles that need to
-- RESTATE cost need cost:manage, which was previously reachable through inventory:adjust.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", (SELECT "id" FROM "permissions" WHERE "key" = 'cost:manage')
FROM "roles" r
WHERE r."name" IN ('ADMIN', 'INVENTORY_MANAGER', 'SUPER_ADMIN')
ON CONFLICT DO NOTHING;

-- ── 4. Try-on comes off product:create ──────────────────────────────────────
-- It is metered and billed, so anyone who could add a product could spend the allowance.
-- Given back only to the roles that manage the catalogue commercially.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", (SELECT "id" FROM "permissions" WHERE "key" = 'tryon:generate')
FROM "roles" r
WHERE r."name" IN ('ADMIN', 'INVENTORY_MANAGER', 'SUPER_ADMIN')
ON CONFLICT DO NOTHING;

-- ── 5. Reading a colleague's password comes off admin:users ─────────────────
-- Listing the team and reading someone's password in plain text were the same key. Only
-- whoever already holds admin:users gets it back, and only in ADMIN -- a shop can grant it
-- further if it decides to, which is now a decision rather than a side effect.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", (SELECT "id" FROM "permissions" WHERE "key" = 'team:view_password')
FROM "roles" r
WHERE r."name" IN ('ADMIN', 'SUPER_ADMIN')
ON CONFLICT DO NOTHING;

-- ── 6. dispatch:view guarded nothing, and is removed ────────────────────────
-- There is no read endpoint for dispatches -- one is created, then seen through its sales
-- order -- so the key protected nothing while looking like it did. dispatch:create now implies
-- sales_order:view directly. Any grant of it is deleted; nobody loses access to anything,
-- because it never controlled access to anything.
DELETE FROM "role_permissions"
WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "key" = 'dispatch:view');
DELETE FROM "permissions" WHERE "key" = 'dispatch:view';

-- Note on what is NOT here: no role LOSES dashboard:view. It still exists and still gates the
-- dashboard itself. What changed is that it no longer carries the shop's financial position
-- with it.

-- ── 7. SUPER_ADMIN's authority becomes a grant instead of a string ──────────
-- Until now requirePermission returned early if the user's role NAMES contained 'SUPER_ADMIN'.
-- The stored permissions of those roles were therefore never read, and had drifted: they held
-- 26 stale keys, several of which guard nothing, and lacked dashboard:view entirely.
--
-- This must run BEFORE the code that stops reading names, which is why it is in the same
-- migration as the deploy that removes it. Prisma applies migrations before the server starts,
-- so the grant exists by the time anything checks for it. Getting this order wrong logs out
-- every account owner on the platform.
INSERT INTO "permissions" ("id", "key", "description")
VALUES (gen_random_uuid(), '*', 'Everything (account owner)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", (SELECT "id" FROM "permissions" WHERE "key" = '*')
FROM "roles" r
WHERE r."name" = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;

-- ── 8. Keys that were granted but guard nothing ─────────────────────────────
-- dispatch:cancel, dispatch:execute, inventory:create, inventory:update, returns:create,
-- returns:view and the user:* family are held by real roles and gate no route -- left over
-- from an older catalogue. They are not removed here: they grant nothing either way, and a
-- DELETE that silently empties a role a merchant has looked at is worse than a dead row.
-- config/permissions.ts is the list that matters now, and verify-permissions.ts fails if a
-- route is ever gated on one of them.
