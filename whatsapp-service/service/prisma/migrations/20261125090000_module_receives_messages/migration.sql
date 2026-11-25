-- A module may receive customers' messages to a shop's number (message.received), opt-in per module (CRM only,
-- 25 Nov 2026). Additive: a new column, false for every module that exists.
ALTER TABLE "ModuleClient" ADD COLUMN IF NOT EXISTS "receivesMessages" BOOLEAN NOT NULL DEFAULT false;
