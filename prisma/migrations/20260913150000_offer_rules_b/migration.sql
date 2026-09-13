-- Offers, second round: the rules shops asked for after the first.
--
--   per_piece      "200 off each saree" takes 200 off every piece, not once per line.
--   customer_tags  an offer only for customers tagged VIP, STAFF, WHOLESALE...
--   schedule       happy hours: {"days":[1,2,3,4,5],"from":"16:00","to":"19:00"} in the shop's time.
--   unique_codes   the offer is unlocked by single-use codes in offer_codes, not one shared code.
--   offer_exclusions  "everything except bridal lehengas".
--   customers.tags    the groups a customer belongs to.
--   client_settings.manual_discount_max_percent  how much a till may take off by hand unaided.
--   sales_order_discounts.applied_by / code       who took money off, and which code was spent.

ALTER TABLE "offers"
  ADD COLUMN "per_piece" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "customer_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "schedule" JSONB,
  ADD COLUMN "unique_codes" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "offer_exclusions" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "scope" "OfferScope" NOT NULL,
    "ref_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_exclusions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "offer_exclusions_offer_id_scope_ref_id_key" ON "offer_exclusions"("offer_id", "scope", "ref_id");
CREATE INDEX "offer_exclusions_offer_id_idx" ON "offer_exclusions"("offer_id");
ALTER TABLE "offer_exclusions" ADD CONSTRAINT "offer_exclusions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "offer_codes" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sales_order_id" TEXT,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "offer_codes_client_id_code_key" ON "offer_codes"("client_id", "code");
CREATE INDEX "offer_codes_offer_id_idx" ON "offer_codes"("offer_id");
CREATE INDEX "offer_codes_sales_order_id_idx" ON "offer_codes"("sales_order_id");
ALTER TABLE "offer_codes" ADD CONSTRAINT "offer_codes_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customers" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "client_settings" ADD COLUMN "manual_discount_max_percent" DECIMAL(5,2);

ALTER TABLE "sales_order_discounts"
  ADD COLUMN "applied_by" TEXT,
  ADD COLUMN "code" TEXT;

-- Two permissions. Taking off more than the till limit is a manager's call; setting that limit is
-- the owner's. Both granted to the built-in ADMIN role on every shop, matching the ADMIN template.
INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'offer:manual_discount_unlimited', 'Take off more than the till limit by hand'),
  (gen_random_uuid()::text, 'offer:settings', 'Set how much the till may take off by hand')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('offer:manual_discount_unlimited', 'offer:settings')
WHERE r."name" = 'ADMIN'
ON CONFLICT DO NOTHING;
