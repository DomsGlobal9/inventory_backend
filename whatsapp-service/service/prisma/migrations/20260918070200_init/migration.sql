-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('SCALEEZY', 'CLIENT');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('NOT_LINKED', 'LINKING', 'CONNECTED', 'DISCONNECTED', 'LOGGED_OUT');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'TEST');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "clientId" TEXT,
    "instanceName" TEXT NOT NULL,
    "phone" TEXT,
    "displayName" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'NOT_LINKED',
    "linkedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dailyCap" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountStatusLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "from" "AccountStatus" NOT NULL,
    "to" "AccountStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountStatusLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "webhookSecretEncrypted" TEXT,
    "canSendAsScaleEzy" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "moduleId" TEXT,
    "toDigits" TEXT NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "reference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "text" TEXT,
    "document" BYTEA,
    "fileName" TEXT,
    "mimeType" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "failReason" TEXT,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "engineMessageId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sendingAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptOut" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "toDigits" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberCheck" (
    "toDigits" TEXT NOT NULL,
    "onWhatsApp" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NumberCheck_pkey" PRIMARY KEY ("toDigits")
);

-- CreateTable
CREATE TABLE "EngineReceipt" (
    "engineMessageId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineReceipt_pkey" PRIMARY KEY ("engineMessageId")
);

-- CreateTable
CREATE TABLE "ModuleEvent" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanaryRun" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageId" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "CanaryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_clientId_key" ON "Account"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_instanceName_key" ON "Account"("instanceName");

-- CreateIndex
CREATE INDEX "Account_kind_idx" ON "Account"("kind");

-- CreateIndex
CREATE INDEX "AccountStatusLog_accountId_at_idx" ON "AccountStatusLog"("accountId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleClient_name_key" ON "ModuleClient"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleClient_keyHash_key" ON "ModuleClient"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Message_engineMessageId_key" ON "Message"("engineMessageId");

-- CreateIndex
CREATE INDEX "Message_status_accountId_nextAttemptAt_idx" ON "Message"("status", "accountId", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "Message_accountId_toDigits_contentHash_queuedAt_idx" ON "Message"("accountId", "toDigits", "contentHash", "queuedAt");

-- CreateIndex
CREATE INDEX "Message_accountId_sentAt_idx" ON "Message"("accountId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_moduleId_idempotencyKey_key" ON "Message"("moduleId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OptOut_accountId_toDigits_key" ON "OptOut"("accountId", "toDigits");

-- CreateIndex
CREATE INDEX "ModuleEvent_deliveredAt_failedAt_nextAttemptAt_idx" ON "ModuleEvent"("deliveredAt", "failedAt", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "AccountStatusLog" ADD CONSTRAINT "AccountStatusLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "ModuleClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptOut" ADD CONSTRAINT "OptOut_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleEvent" ADD CONSTRAINT "ModuleEvent_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "ModuleClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
