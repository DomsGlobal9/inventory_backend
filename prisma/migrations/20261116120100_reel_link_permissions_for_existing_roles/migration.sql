-- Reel links (PLAN-reel-links.md): reel_link:view (see them and how many opened them) and reel_link:manage (make,
-- change, switch off). Every shop's ADMIN gets both, as a new shop's does (the template holds manage, which implies
-- view). Only ever adds; a shop's own roles are not touched; SUPER_ADMIN holds the wildcard. Safe to run again.

INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'reel_link:view', 'See reel links and how many people opened them'),
  (gen_random_uuid()::text, 'reel_link:manage', 'Make reel links, change their pieces, and switch them off')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('reel_link:view', 'reel_link:manage')
WHERE r."name" = 'ADMIN'
ON CONFLICT DO NOTHING;
