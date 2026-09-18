-- Guards Prisma cannot express: exactly one ScaleEzy number, and a client id on (only) client numbers.
CREATE UNIQUE INDEX "Account_one_scaleezy" ON "Account"("kind") WHERE "kind" = 'SCALEEZY';
ALTER TABLE "Account" ADD CONSTRAINT "Account_clientId_matches_kind"
  CHECK (("kind" = 'SCALEEZY' AND "clientId" IS NULL) OR ("kind" = 'CLIENT' AND "clientId" IS NOT NULL));
