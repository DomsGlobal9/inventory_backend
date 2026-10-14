-- Loyalty and campaign permissions for ADMIN roles that shops ALREADY have.
--
-- 20260921120000_loyalty_campaigns added loyalty:manage and campaign:send to the ADMIN template,
-- but a template is only read when a shop is created. Every shop made before 21 Sep 2026 has an
-- ADMIN that cannot change loyalty settings or send a campaign -- measured on 14 Oct: 4 shops
-- (verify-permission-catalogue.ts, section E). Same shape as 20260913090000 for offers.
--
-- Only ever ADDS, only to roles still called ADMIN; a shop's own roles are not touched.
-- ON CONFLICT DO NOTHING makes it safe to run again. The permission rows already exist (new shops use them).

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('loyalty:manage', 'campaign:send')
WHERE r."name" = 'ADMIN'
ON CONFLICT DO NOTHING;
