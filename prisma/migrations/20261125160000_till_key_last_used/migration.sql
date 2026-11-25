-- When a till/website key last opened Inventory (25 Nov 2026). Written by the storefront key check at most every five
-- minutes; read by the POS key doctor (services/pos-switch/doctor.ts). Additive, nullable: nothing else changes.
ALTER TABLE "storefront_connections" ADD COLUMN "last_used_at" TIMESTAMP(3);
