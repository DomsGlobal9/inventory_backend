-- 17 Nov 2026, the owner: measurements and stitching are the boutique's (CRM-B's) alone -- "boutique means CRM-B
-- only" -- and CRM is the shop's own customer list, so it shows these people as ordinary customers with nothing
-- boutique about them. ScaleEzy keeps only the boutique person -> customer link (for matching by phone, and for telling
-- the boutique whom to wipe). The snapshot column stays for now (empty, never written) so a build still running during
-- the deploy keeps working; any snapshot already stored is cleared.
UPDATE "customer_boutique_profiles" SET "snapshot" = '{}'::jsonb, "snapshot_at" = NULL WHERE "snapshot" <> '{}'::jsonb OR "snapshot_at" IS NOT NULL;
