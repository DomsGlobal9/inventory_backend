-- WhatsApp: the nightly Day Book choice, messages sent from Inventory, and events already handled.
CREATE TABLE "whatsapp_settings" (
    "client_id" TEXT NOT NULL,
    "day_book_enabled" BOOLEAN NOT NULL DEFAULT false,
    "day_book_time" TEXT NOT NULL DEFAULT '22:00',
    "day_book_to" TEXT,
    "day_book_last_sent_for" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_settings_pkey" PRIMARY KEY ("client_id")
);

CREATE TABLE "whatsapp_messages" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "service_message_id" TEXT,
    "kind" TEXT NOT NULL,
    "reference_id" TEXT,
    "to_masked" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "fail_reason" TEXT,
    "sent_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "whatsapp_messages_service_message_id_key" ON "whatsapp_messages"("service_message_id");
CREATE INDEX "whatsapp_messages_client_id_kind_reference_id_created_at_idx" ON "whatsapp_messages"("client_id", "kind", "reference_id", "created_at");

CREATE TABLE "whatsapp_events_seen" (
    "id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_events_seen_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "whatsapp_events_seen_received_at_idx" ON "whatsapp_events_seen"("received_at");

-- Linking and unlinking the shop's own WhatsApp number. The owner holds it through '*'; an
-- ADMIN role that already manages the team gets it too. Nobody else.
INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'whatsapp:manage', 'Link and unlink the shop''s WhatsApp number')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'whatsapp:manage'
WHERE r."name" = 'ADMIN'
  AND EXISTS (
    SELECT 1 FROM "role_permissions" rp JOIN "permissions" k ON k."id" = rp."permission_id"
    WHERE rp."role_id" = r."id" AND k."key" = 'admin:users'
  )
ON CONFLICT DO NOTHING;
