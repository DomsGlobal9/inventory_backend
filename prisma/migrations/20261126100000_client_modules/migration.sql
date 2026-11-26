-- One-switch onboarding (26 Nov 2026, PLAN-onboarding-modules.md): one record of which modules each client has, the
-- platform's list of clients (with or without Inventory), and the queue that tells each module about a change.
-- Additive. Existing clients are filled in from what is true today (source 'backfill'):
--   inventory  a client with an active login          logistics  module_subscriptions 'logistics'
--   crm        module_subscriptions 'crm'              pos        a till key (pos://counter) not revoked
--   boutique   a boutique link not ended

CREATE TABLE "client_modules" (
    "client_id"  TEXT NOT NULL,
    "module"     TEXT NOT NULL,
    "on"         BOOLEAN NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" TEXT,
    "source"     TEXT NOT NULL,
    CONSTRAINT "client_modules_pkey" PRIMARY KEY ("client_id", "module")
);
CREATE INDEX "client_modules_module_on_idx" ON "client_modules"("module", "on");

CREATE TABLE "platform_clients" (
    "client_id"  TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "version"    INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_clients_pkey" PRIMARY KEY ("client_id")
);

CREATE TABLE "module_connects" (
    "client_id"       TEXT NOT NULL,
    "module"          TEXT NOT NULL,
    "action"          TEXT NOT NULL,
    "version"         INTEGER NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'PENDING',
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at"       TIMESTAMP(3),
    "last_error"      TEXT,
    "answer"          JSONB,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at"         TIMESTAMP(3),
    CONSTRAINT "module_connects_pkey" PRIMARY KEY ("client_id", "module")
);
CREATE INDEX "module_connects_status_next_attempt_at_idx" ON "module_connects"("status", "next_attempt_at");

-- The clients known today: every client with a login, a boutique link, a module subscription or a till key.
INSERT INTO "platform_clients" ("client_id", "name", "version")
SELECT k.client_id, COALESCE(NULLIF(TRIM(cs.business_name), ''), k.client_id), 1
FROM (
    SELECT client_id FROM users
    UNION SELECT client_id FROM boutique_links
    UNION SELECT client_id FROM module_subscriptions
    UNION SELECT client_id FROM storefront_connections WHERE base_url = 'pos://counter'
) k
LEFT JOIN client_settings cs ON cs.client_id = k.client_id
ON CONFLICT DO NOTHING;

INSERT INTO "client_modules" ("client_id", "module", "on", "source")
SELECT p.client_id, 'inventory', EXISTS (SELECT 1 FROM users u WHERE u.client_id = p.client_id AND u.status = 'ACTIVE'), 'backfill'
FROM platform_clients p
ON CONFLICT DO NOTHING;

INSERT INTO "client_modules" ("client_id", "module", "on", "source")
SELECT client_id, module, TRUE, 'backfill' FROM module_subscriptions WHERE module IN ('crm', 'logistics')
ON CONFLICT DO NOTHING;

INSERT INTO "client_modules" ("client_id", "module", "on", "source")
SELECT DISTINCT client_id, 'pos', TRUE, 'backfill' FROM storefront_connections
WHERE base_url = 'pos://counter' AND status <> 'REVOKED'
ON CONFLICT DO NOTHING;

INSERT INTO "client_modules" ("client_id", "module", "on", "source")
SELECT client_id, 'boutique', TRUE, 'backfill' FROM boutique_links WHERE unlinked_at IS NULL
ON CONFLICT DO NOTHING;
