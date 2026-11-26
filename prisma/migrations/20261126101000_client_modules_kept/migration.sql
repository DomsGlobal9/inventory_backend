-- What a module's feed row held when the module was switched off (CRM: which customer features it runs), put back
-- when it is switched on again, so switching off and on never loses a hand-over (26 Nov 2026). Additive.
ALTER TABLE "client_modules" ADD COLUMN "kept" JSONB;
