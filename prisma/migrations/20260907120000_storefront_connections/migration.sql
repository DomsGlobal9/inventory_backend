-- Storefront connections, events and deliveries.
--
-- ADDITIVE ONLY. Nothing existing is dropped, retyped or deleted.
--
-- That is deliberate rather than tidy. The deployed backend writes to inventory_events inside
-- the same transaction as every stock movement. Reshaping that table -- which the new design
-- would otherwise want, since a single `status` column cannot describe several destinations --
-- would fail every stock-in, stock-out and sale for every tenant during the window between
-- this migration running and the new code starting. So inventory_events is left exactly as it
-- is, stops being written once the new code ships, and can be dropped in a later migration
-- once nothing references it.

-- CreateEnum
CREATE TYPE "StorefrontEventType" AS ENUM ('STOCK_UPDATED', 'PRODUCT_PUBLISHED', 'PRODUCT_UPDATED', 'PRODUCT_UNPUBLISHED', 'PRICE_CHANGED', 'AVAILABILITY_CHANGED');

-- CreateEnum
CREATE TYPE "StorefrontConnectionType" AS ENUM ('GENERIC', 'SHOPIFY', 'WOOCOMMERCE');

-- CreateEnum
CREATE TYPE "StorefrontConnectionStatus" AS ENUM ('PENDING_SYNC', 'ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED');

-- CreateTable
CREATE TABLE "storefront_events" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "client_id" TEXT NOT NULL,
    "event_type" "StorefrontEventType" NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "product_code" TEXT,
    "sku" TEXT,
    "variant_id" TEXT,
    "location_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_connections" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StorefrontConnectionType" NOT NULL DEFAULT 'GENERIC',
    "status" "StorefrontConnectionStatus" NOT NULL DEFAULT 'PENDING_SYNC',
    "base_url" TEXT NOT NULL,
    "credential_hash" TEXT NOT NULL,
    "credential_prefix" TEXT NOT NULL,
    "location_ids" TEXT[],
    "sync_cursor" TEXT,
    "synced_at" TIMESTAMP(3),
    "last_delivery_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefront_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "last_response_status" INTEGER,
    "last_error" TEXT,
    "last_duration_ms" INTEGER,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storefront_events_client_id_sequence_idx" ON "storefront_events"("client_id", "sequence");

-- CreateIndex
CREATE INDEX "storefront_events_client_id_created_at_idx" ON "storefront_events"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "storefront_events_event_type_idx" ON "storefront_events"("event_type");

-- CreateIndex
CREATE INDEX "storefront_connections_client_id_idx" ON "storefront_connections"("client_id");

-- CreateIndex
CREATE INDEX "storefront_connections_client_id_status_idx" ON "storefront_connections"("client_id", "status");

-- CreateIndex
CREATE INDEX "storefront_connections_credential_prefix_idx" ON "storefront_connections"("credential_prefix");

-- CreateIndex
CREATE INDEX "storefront_deliveries_status_next_attempt_at_idx" ON "storefront_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "storefront_deliveries_client_id_status_idx" ON "storefront_deliveries"("client_id", "status");

-- CreateIndex
CREATE INDEX "storefront_deliveries_connection_id_created_at_idx" ON "storefront_deliveries"("connection_id", "created_at");

-- CreateIndex: one delivery per event per connection, enforced rather than assumed.
CREATE UNIQUE INDEX "uq_delivery_event_connection" ON "storefront_deliveries"("event_id", "connection_id");

-- AddForeignKey
ALTER TABLE "storefront_deliveries" ADD CONSTRAINT "storefront_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "storefront_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_deliveries" ADD CONSTRAINT "storefront_deliveries_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "storefront_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
