-- A customer group's own settings; membership stays in customers.tags.
CREATE TABLE "customer_groups" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "no_offer_messages" BOOLEAN NOT NULL DEFAULT false,
    "no_wishes" BOOLEAN NOT NULL DEFAULT false,
    "auto_min_spend" DECIMAL(12,2),
    "auto_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_groups_client_id_key_key" ON "customer_groups"("client_id", "key");
