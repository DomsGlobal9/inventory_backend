-- Racks and shelves: where inside a location the pieces are.
--
-- Only ADDS. New tables, one new InventoryReason value (SHELF_MOVE), checks and triggers on the new
-- tables, one trigger on inventory_stocks that fires only when a quantity falls, and three permissions
-- granted to built-in roles by what they can already do. No existing row changes except role_permissions
-- gaining rows. The old backend never writes SHELF_MOVE or touches the new tables, so this is safe to
-- apply before the deploy.

-- CreateEnum
CREATE TYPE "StorageSpotKind" AS ENUM ('AREA', 'RACK', 'CUPBOARD', 'SHELF', 'BOX', 'STACK', 'BUNDLE', 'RAIL', 'RAIL_SECTION', 'COUNTER', 'DRAWER', 'DISPLAY', 'TRUNK', 'OTHER');

-- CreateEnum
CREATE TYPE "SpotLegSource" AS ENUM ('SCANNED', 'AUTO');

-- CreateEnum
CREATE TYPE "ShelfIssueKind" AS ENUM ('SOLD_FROM_BACK_ROOM', 'AUTO_TAKEN_FROM_SHELF', 'COUNT_BELOW_SHELVES', 'NOT_FOUND_ON_SHELF');

-- CreateEnum
CREATE TYPE "ShelfIssueStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterEnum
ALTER TYPE "InventoryReason" ADD VALUE 'SHELF_MOVE';

-- CreateTable
CREATE TABLE "storage_spots" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "kind" "StorageSpotKind" NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "depth" INTEGER NOT NULL,
    "walk_order" INTEGER NOT NULL DEFAULT 0,
    "is_shop_floor" BOOLEAN NOT NULL DEFAULT false,
    "label_code" TEXT NOT NULL,
    "colour" TEXT,
    "capacity" INTEGER,
    "is_temporary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_spots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spot_stocks" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "spot_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spot_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transaction_spots" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "spot_id" TEXT,
    "address" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "source" "SpotLegSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transaction_spots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shelf_issues" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "spot_id" TEXT,
    "address" TEXT,
    "transaction_id" TEXT,
    "kind" "ShelfIssueKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "status" "ShelfIssueStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shelf_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_spot_address_changes" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "spot_id" TEXT NOT NULL,
    "old_address" TEXT NOT NULL,
    "new_address" TEXT NOT NULL,
    "changed_by" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_spot_address_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storage_spots_client_id_location_id_idx" ON "storage_spots"("client_id", "location_id");

-- CreateIndex
CREATE INDEX "storage_spots_parent_id_idx" ON "storage_spots"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_spots_location_id_address_key" ON "storage_spots"("location_id", "address");

-- CreateIndex
CREATE UNIQUE INDEX "storage_spots_client_id_label_code_key" ON "storage_spots"("client_id", "label_code");

-- CreateIndex
CREATE INDEX "spot_stocks_variant_id_location_id_idx" ON "spot_stocks"("variant_id", "location_id");

-- CreateIndex
CREATE INDEX "spot_stocks_client_id_location_id_idx" ON "spot_stocks"("client_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "spot_stocks_spot_id_variant_id_key" ON "spot_stocks"("spot_id", "variant_id");

-- CreateIndex
CREATE INDEX "inventory_transaction_spots_transaction_id_idx" ON "inventory_transaction_spots"("transaction_id");

-- CreateIndex
CREATE INDEX "inventory_transaction_spots_spot_id_created_at_idx" ON "inventory_transaction_spots"("spot_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_transaction_spots_variant_id_location_id_created__idx" ON "inventory_transaction_spots"("variant_id", "location_id", "created_at");

-- CreateIndex
CREATE INDEX "shelf_issues_client_id_status_created_at_idx" ON "shelf_issues"("client_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "shelf_issues_location_id_status_idx" ON "shelf_issues"("location_id", "status");

-- CreateIndex
CREATE INDEX "shelf_issues_variant_id_idx" ON "shelf_issues"("variant_id");

-- CreateIndex
CREATE INDEX "storage_spot_address_changes_spot_id_changed_at_idx" ON "storage_spot_address_changes"("spot_id", "changed_at");

-- AddForeignKey
ALTER TABLE "storage_spots" ADD CONSTRAINT "storage_spots_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_spots" ADD CONSTRAINT "storage_spots_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "storage_spots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spot_stocks" ADD CONSTRAINT "spot_stocks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spot_stocks" ADD CONSTRAINT "spot_stocks_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "storage_spots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spot_stocks" ADD CONSTRAINT "spot_stocks_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_spots" ADD CONSTRAINT "inventory_transaction_spots_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "inventory_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_spots" ADD CONSTRAINT "inventory_transaction_spots_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "storage_spots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_issues" ADD CONSTRAINT "shelf_issues_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_issues" ADD CONSTRAINT "shelf_issues_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_issues" ADD CONSTRAINT "shelf_issues_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "storage_spots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_issues" ADD CONSTRAINT "shelf_issues_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "inventory_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_spot_address_changes" ADD CONSTRAINT "storage_spot_address_changes_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "storage_spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Rules the database holds itself ────────────────────────────────────────────────────────────
--
-- The application checks all of these first, to give a sentence instead of an error. These are for
-- the write path nobody has thought of yet.

ALTER TABLE "storage_spots"
  ADD CONSTRAINT "storage_spots_code_format"    CHECK ("code" ~ '^[A-Z0-9]{1,12}$'),
  ADD CONSTRAINT "storage_spots_address_format" CHECK ("address" ~ '^[A-Z0-9]{1,12}(-[A-Z0-9]{1,12}){0,3}$'),
  ADD CONSTRAINT "storage_spots_depth_range"    CHECK ("depth" BETWEEN 1 AND 4),
  ADD CONSTRAINT "storage_spots_label_format"   CHECK ("label_code" ~ '^[A-Z0-9]{6,16}$'),
  ADD CONSTRAINT "storage_spots_walk_order"     CHECK ("walk_order" >= 0),
  ADD CONSTRAINT "storage_spots_capacity"       CHECK ("capacity" IS NULL OR "capacity" > 0),
  ADD CONSTRAINT "storage_spots_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

ALTER TABLE "spot_stocks"
  ADD CONSTRAINT "spot_stocks_quantity_not_negative" CHECK ("quantity" >= 0);

ALTER TABLE "inventory_transaction_spots"
  ADD CONSTRAINT "inventory_transaction_spots_quantity_not_zero" CHECK ("quantity" <> 0);

ALTER TABLE "shelf_issues"
  ADD CONSTRAINT "shelf_issues_quantity_positive" CHECK ("quantity" > 0);

-- ─── The tree ───────────────────────────────────────────────────────────────────────────────────
--
-- Checked at commit, so a change of address can rewrite a spot and everything under it in any order.
--   * a parent is in the same shop and location, one level up, and its address prefixes the child's
--   * an area (no parent) is depth 1 and its address is its own code
--   * a spot holding stock has no children
-- "depth = parent depth + 1" also makes a loop impossible.

CREATE OR REPLACE FUNCTION storage_spot_tree_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s storage_spots%ROWTYPE;
  p storage_spots%ROWTYPE;
BEGIN
  SELECT * INTO s FROM storage_spots WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF s.parent_id IS NULL THEN
    IF s.depth <> 1 OR s.address <> s.code THEN
      RAISE EXCEPTION 'storage_spot_tree: area % must be depth 1 with its code as address', s.address
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO p FROM storage_spots WHERE id = s.parent_id;
    IF p.client_id <> s.client_id OR p.location_id <> s.location_id THEN
      RAISE EXCEPTION 'storage_spot_tree: % sits under a spot in another location', s.address
        USING ERRCODE = 'check_violation';
    END IF;
    IF s.depth <> p.depth + 1 OR s.address <> p.address || '-' || s.code THEN
      RAISE EXCEPTION 'storage_spot_tree: % does not follow its parent %', s.address, p.address
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM spot_stocks WHERE spot_id = p.id) THEN
      RAISE EXCEPTION 'storage_spot_tree: % holds stock, so nothing can be placed under it', p.address
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM storage_spots c
    WHERE c.parent_id = s.id
      AND (c.depth <> s.depth + 1 OR c.address <> s.address || '-' || c.code OR c.location_id <> s.location_id)
  ) THEN
    RAISE EXCEPTION 'storage_spot_tree: a spot under % does not follow it', s.address
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "storage_spots_tree_guard"
  AFTER INSERT OR UPDATE ON "storage_spots"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION storage_spot_tree_guard();

-- ─── The rule: shelves never hold more than the location has ────────────────────────────────────
--
--   sum(spot_stocks.quantity) for a variant at a location  <=  inventory_stocks.quantity
--
-- Not shelved is the difference and is never stored, so this one inequality is the whole invariant.
-- Checked at commit, after every write in the transaction, from both sides.

CREATE OR REPLACE FUNCTION shelf_stock_within_location(p_variant TEXT, p_location TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  on_shelves BIGINT;
  official   INTEGER;
BEGIN
  SELECT COALESCE(SUM(quantity), 0) INTO on_shelves
    FROM spot_stocks WHERE variant_id = p_variant AND location_id = p_location;
  IF on_shelves = 0 THEN
    RETURN;
  END IF;
  -- Locked, so two transactions cannot each check against the other's old numbers and both commit:
  -- one putting pieces on a shelf while another lowers the location. The second waits, then re-reads
  -- both numbers.
  SELECT quantity INTO official
    FROM inventory_stocks WHERE variant_id = p_variant AND location_id = p_location
    FOR UPDATE;
  SELECT COALESCE(SUM(quantity), 0) INTO on_shelves
    FROM spot_stocks WHERE variant_id = p_variant AND location_id = p_location;
  IF on_shelves > COALESCE(official, 0) THEN
    RAISE EXCEPTION 'shelf_stock_exceeds_location: shelves hold % of variant % at location %, the location has %',
      on_shelves, p_variant, p_location, COALESCE(official, 0)
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION spot_stock_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r  spot_stocks%ROWTYPE;
  sp storage_spots%ROWTYPE;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT * INTO r FROM spot_stocks WHERE id = NEW.id;
    IF FOUND THEN
      SELECT * INTO sp FROM storage_spots WHERE id = r.spot_id;
      IF sp.client_id <> r.client_id OR sp.location_id <> r.location_id THEN
        RAISE EXCEPTION 'spot_stock: stock recorded on % belongs to another location', sp.address
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM storage_spots WHERE parent_id = sp.id) THEN
        RAISE EXCEPTION 'spot_stock: % has spots under it, so it cannot hold stock', sp.address
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM inventory_product_variants v WHERE v.id = r.variant_id AND v.client_id = r.client_id) THEN
        RAISE EXCEPTION 'spot_stock: variant % is not this shop''s', r.variant_id
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM shelf_stock_within_location(r.variant_id, r.location_id);
    END IF;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM shelf_stock_within_location(OLD.variant_id, OLD.location_id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "spot_stocks_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "spot_stocks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION spot_stock_guard();

CREATE OR REPLACE FUNCTION inventory_stock_shelf_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM shelf_stock_within_location(OLD.variant_id, OLD.location_id);
  RETURN NULL;
END;
$$;

-- Only a fall in the location's quantity, or the row going, can break the rule. A shop with no shelves
-- pays one indexed lookup that finds nothing.
CREATE CONSTRAINT TRIGGER "inventory_stocks_shelf_guard_update"
  AFTER UPDATE OF "quantity" ON "inventory_stocks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."quantity" < OLD."quantity")
  EXECUTE FUNCTION inventory_stock_shelf_guard();

CREATE CONSTRAINT TRIGGER "inventory_stocks_shelf_guard_delete"
  AFTER DELETE ON "inventory_stocks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_stock_shelf_guard();

-- ─── Permissions ────────────────────────────────────────────────────────────────────────────────
--
-- Granted to the built-in roles by what each can already do, not by name alone: a shop that edited its
-- SALES role (sphl did) gets shelf:view only if that role can still see products, stock or orders.
-- SUPER_ADMIN holds '*' and needs nothing. Custom roles are left to the shop.

INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'shelf:view',    'See where stock is kept'),
  (gen_random_uuid()::text, 'shelf:putaway', 'Put stock away and move it between shelves'),
  (gen_random_uuid()::text, 'shelf:manage',  'Set up racks and shelves, print labels')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'shelf:view'
WHERE r."name" IN ('ADMIN', 'SALES', 'WAREHOUSE', 'INVENTORY_MANAGER')
  AND EXISTS (
    SELECT 1 FROM "role_permissions" rp JOIN "permissions" k ON k."id" = rp."permission_id"
    WHERE rp."role_id" = r."id"
      AND k."key" IN ('product:view', 'inventory:view', 'inventory:receive', 'inventory:adjust', 'inventory:transfer',
                      'sales_order:create', 'sales_order:counter_sale', 'stock_count:view', 'dispatch:create')
  )
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'shelf:putaway'
WHERE r."name" IN ('ADMIN', 'WAREHOUSE', 'INVENTORY_MANAGER')
  AND EXISTS (
    SELECT 1 FROM "role_permissions" rp JOIN "permissions" k ON k."id" = rp."permission_id"
    WHERE rp."role_id" = r."id" AND k."key" IN ('inventory:receive', 'inventory:transfer')
  )
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'shelf:manage'
WHERE r."name" IN ('ADMIN', 'INVENTORY_MANAGER')
  AND EXISTS (
    SELECT 1 FROM "role_permissions" rp JOIN "permissions" k ON k."id" = rp."permission_id"
    WHERE rp."role_id" = r."id" AND k."key" = 'admin:locations'
  )
ON CONFLICT DO NOTHING;
