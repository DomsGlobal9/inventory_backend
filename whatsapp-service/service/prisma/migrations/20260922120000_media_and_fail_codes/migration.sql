-- Pictures by address, link previews, and a failure code beside the failure words.
-- Only additions with defaults or NULLs: the running service and older modules are unaffected.
CREATE TYPE "MediaType" AS ENUM ('IMAGE');
CREATE TYPE "FailCode" AS ENUM ('NOT_ON_WHATSAPP', 'MEDIA_FETCH_FAILED', 'MEDIA_UNREADABLE', 'ENGINE_GAVE_UP', 'ENGINE_REJECTED', 'DELIVERY_FAILED', 'EXPIRED');

ALTER TABLE "Message"
  ADD COLUMN "mediaUrl" TEXT,
  ADD COLUMN "mediaType" "MediaType",
  ADD COLUMN "linkPreview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "failCode" "FailCode";

-- A message carries a picture only with its type, and never a picture and a document together.
ALTER TABLE "Message" ADD CONSTRAINT "Message_media_pair" CHECK (("mediaUrl" IS NULL) = ("mediaType" IS NULL));
ALTER TABLE "Message" ADD CONSTRAINT "Message_media_or_document" CHECK (NOT ("mediaUrl" IS NOT NULL AND "document" IS NOT NULL));
