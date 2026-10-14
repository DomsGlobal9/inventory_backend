-- customer:manage_groups: a group's WhatsApp rules, joining by spending, renaming, merging and
-- deleting. Putting customers in a group stays customer:update.
--
-- The permission row, and every shop's ADMIN gets it (the ADMIN template now holds it). Only ever
-- adds; a shop's own roles are not touched; SUPER_ADMIN holds the wildcard. Safe to run again.

INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'customer:manage_groups', 'Manage customer groups: their WhatsApp rules, renaming, merging and deleting')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'customer:manage_groups'
WHERE r."name" = 'ADMIN'
ON CONFLICT DO NOTHING;
