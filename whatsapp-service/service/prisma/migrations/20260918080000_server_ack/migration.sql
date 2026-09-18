-- When WhatsApp's server confirmed a message (engine SERVER_ACK).
ALTER TABLE "Message" ADD COLUMN "serverAckAt" TIMESTAMP(3);
