-- Offer permissions for roles that shops ALREADY have.
--
-- rbac-seed.service.ts now grants offer permissions in the role templates, but a template is only
-- read when a shop is created. Every shop that existed before that change has built-in roles
-- holding no offer permission at all -- measured on 13 Sep 2026: 10 shops, 39 built-in roles, none
-- with offer:view -- so on every existing shop nobody but the owner could see Offers, and nobody
-- at the counter could take money off with a reason.
--
-- What each built-in role gains, matching the templates exactly:
--
--   ADMIN               offer:view, offer:create, offer:update, offer:archive, offer:manual_discount
--   SALES               offer:view, offer:manual_discount
--   WAREHOUSE           offer:view
--   INVENTORY_MANAGER   offer:view
--
-- Only ever ADDS. A role a shop created itself, or renamed, is not touched: a shop that built its
-- own role structure made its own decisions and a migration should not second-guess them.
-- ON CONFLICT DO NOTHING makes it safe to run on a database where some of this already exists.
-- SUPER_ADMIN is not listed: it holds the wildcard.

INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'offer:view',            'See offers and discounts'),
  (gen_random_uuid()::text, 'offer:create',          'Write a new offer'),
  (gen_random_uuid()::text, 'offer:update',          'Change an offer, and start or pause it'),
  (gen_random_uuid()::text, 'offer:archive',         'Retire an offer'),
  (gen_random_uuid()::text, 'offer:manual_discount', 'Take money off at the till, with a reason')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('offer:view', 'offer:create', 'offer:update', 'offer:archive', 'offer:manual_discount')
WHERE r."name" = 'ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('offer:view', 'offer:manual_discount')
WHERE r."name" = 'SALES'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'offer:view'
WHERE r."name" IN ('WAREHOUSE', 'INVENTORY_MANAGER')
ON CONFLICT DO NOTHING;
