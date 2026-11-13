-- Linking a boutique to an EXISTING ScaleEzy shop needs the shop owner's say: the owner makes a one-time code in
-- Inventory and types it into the boutique. Only the code's hash is kept; it works once, for 30 minutes.
-- (A boutique-only shop needs no code: it is made new for that boutique.)
CREATE TABLE IF NOT EXISTS "boutique_link_codes" (
  "code_hash"  TEXT PRIMARY KEY,
  "client_id"  TEXT NOT NULL,
  "created_by" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at"    TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "boutique_link_codes_client_idx" ON "boutique_link_codes" ("client_id");
