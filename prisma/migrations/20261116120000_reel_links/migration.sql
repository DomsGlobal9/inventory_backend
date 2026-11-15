-- Reel links (PLAN-reel-links.md, 16 Nov 2026): the pieces from one Instagram reel, behind one link.
-- Additions only: two new tables, nothing existing is changed, so the running app is unaffected.

-- CreateTable
CREATE TABLE "reel_links" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reel_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "short_code" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "reel_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_link_items" (
    "id" TEXT NOT NULL,
    "reel_link_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "colour" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "reel_link_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reel_links_code_key" ON "reel_links"("code");

-- CreateIndex
CREATE INDEX "reel_links_client_id_created_at_idx" ON "reel_links"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "reel_link_items_product_id_idx" ON "reel_link_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "reel_link_items_reel_link_id_product_id_key" ON "reel_link_items"("reel_link_id", "product_id");

-- AddForeignKey
ALTER TABLE "reel_link_items" ADD CONSTRAINT "reel_link_items_reel_link_id_fkey" FOREIGN KEY ("reel_link_id") REFERENCES "reel_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_link_items" ADD CONSTRAINT "reel_link_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A reel link holds at most 12 pieces, so its order runs 0 to 11.
ALTER TABLE "reel_link_items" ADD CONSTRAINT "reel_link_items_position_ok" CHECK ("position" >= 0 AND "position" < 12);
