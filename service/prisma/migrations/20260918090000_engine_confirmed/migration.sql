-- The confirmation that matters for every message is the engine's own event about it (messages
-- to one's own number get no timely WhatsApp tick), so the column is named for what it holds.
ALTER TABLE "Message" RENAME COLUMN "serverAckAt" TO "engineConfirmedAt";
