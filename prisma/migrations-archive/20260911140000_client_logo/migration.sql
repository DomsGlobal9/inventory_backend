-- The shop's logo: what the browser loads, and which object in storage it is.
-- Both nullable: every existing shop has no logo, and none is required.
ALTER TABLE "client_settings" ADD COLUMN "logo_url" TEXT;
ALTER TABLE "client_settings" ADD COLUMN "logo_path" TEXT;
