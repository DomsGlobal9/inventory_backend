-- The owner of a client with no owner login here (a boutique made by the Boutique app, 26 Nov 2026): POS and CRM
-- need a name and an email or phone to make the owner's own login. Additive.
ALTER TABLE "platform_clients" ADD COLUMN "owner" JSONB;
