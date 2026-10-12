-- A module may manage ScaleEzy's own number (status, link, reconnect) without the admin key.
ALTER TABLE "ModuleClient" ADD COLUMN IF NOT EXISTS "canManageScaleEzy" BOOLEAN NOT NULL DEFAULT false;
