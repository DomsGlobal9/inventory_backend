-- Everything a platform admin does in the console, which until now left no trace.
--
-- Purely additive: a new table with no foreign key to platform_admins. That is deliberate --
-- deleting an admin account is itself one of the actions recorded here, and a trail that
-- disappears along with its subject is not a trail. The admin's email and name are copied
-- into each row for the same reason.
CREATE TABLE "platform_admin_actions" (
    "id" TEXT NOT NULL,
    "platform_admin_id" TEXT NOT NULL,
    "admin_email" TEXT NOT NULL,
    "admin_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "target_label" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admin_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_admin_actions_platform_admin_id_created_at_idx" ON "platform_admin_actions"("platform_admin_id", "created_at");
CREATE INDEX "platform_admin_actions_action_created_at_idx" ON "platform_admin_actions"("action", "created_at");
CREATE INDEX "platform_admin_actions_created_at_idx" ON "platform_admin_actions"("created_at");
