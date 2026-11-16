-- The boutique request ledger remembers what each request id was used for (method, path and body, hashed), so the
-- same id sent for a different change is refused instead of being answered with the first change's answer.
ALTER TABLE "boutique_requests" ADD COLUMN "fingerprint" TEXT;
