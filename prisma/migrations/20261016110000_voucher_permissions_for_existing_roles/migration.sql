-- Gift vouchers: voucher:view (see vouchers, balances, history) and voucher:manage (switch on, rules,
-- extend, block). Every shop's ADMIN gets both, SALES gets view (the templates now hold them). Only
-- ever adds; a shop's own roles are not touched; SUPER_ADMIN holds the wildcard. Safe to run again.

INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'voucher:view', 'See gift vouchers, their balances and history'),
  (gen_random_uuid()::text, 'voucher:manage', 'Switch gift vouchers on, set their rules, and extend or block a voucher')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('voucher:view', 'voucher:manage')
WHERE r."name" = 'ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'voucher:view'
WHERE r."name" = 'SALES'
ON CONFLICT DO NOTHING;
