-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'REJECTED');

-- CreateTable
CREATE TABLE "signup_leads" (
    "id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "message" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "converted_client_id" TEXT,
    "converted_at" TIMESTAMP(3),
    "source_ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signup_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signup_leads_status_idx" ON "signup_leads"("status");

-- CreateIndex
CREATE INDEX "signup_leads_email_idx" ON "signup_leads"("email");

-- CreateIndex
CREATE INDEX "signup_leads_created_at_idx" ON "signup_leads"("created_at");

