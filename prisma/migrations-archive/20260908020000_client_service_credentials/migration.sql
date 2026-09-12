-- CreateEnum
CREATE TYPE "ClientService" AS ENUM ('CATALOG_TRYON');

-- CreateEnum
CREATE TYPE "ClientServiceCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "client_service_credentials" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "service" "ClientService" NOT NULL,
    "key_encrypted" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "status" "ClientServiceCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "added_by_admin" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_service_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_service_credentials_client_id_idx" ON "client_service_credentials"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_service_credentials_client_id_service_key" ON "client_service_credentials"("client_id", "service");


