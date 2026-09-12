-- Phase 4: offers copied into connected Shopify stores.
--
-- One row per offer per store. It is both the record of the copy and its own unit of work
-- (attempts, backoff, lease), because a push is absolute state and can be retried safely.

-- CreateTable
CREATE TABLE "offer_external_mirrors" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "shopify_discount_id" TEXT,
    "kind" TEXT,
    "pushed_hash" TEXT,
    "remote_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "problem" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "last_pushed_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offer_external_mirrors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_external_mirrors_status_next_attempt_at_idx" ON "offer_external_mirrors"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "offer_external_mirrors_client_id_idx" ON "offer_external_mirrors"("client_id");

-- CreateIndex
CREATE INDEX "offer_external_mirrors_shopify_discount_id_idx" ON "offer_external_mirrors"("shopify_discount_id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_external_mirrors_offer_id_installation_id_key" ON "offer_external_mirrors"("offer_id", "installation_id");

-- AddForeignKey
ALTER TABLE "offer_external_mirrors" ADD CONSTRAINT "offer_external_mirrors_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_external_mirrors" ADD CONSTRAINT "offer_external_mirrors_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "shopify_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pushing an offer to a live Shopify store is its own permission: it changes a public shop front,
-- not just what this app charges. Added back to the catalogue now that it guards real routes, and
-- granted to the built-in ADMIN role on every shop, matching the ADMIN template.
INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'offer:publish_external', 'Put an offer on a connected Shopify store, and keep it in step')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'offer:publish_external'
WHERE r."name" = 'ADMIN'
ON CONFLICT DO NOTHING;
