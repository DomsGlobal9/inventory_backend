-- The one message we are allowed to send to a number that replied STOP: a confirmation that it
-- worked, sent once. Without it the customer has no sign we heard them, so they reply STOP again
-- or block the shop's number -- which is the very damage the slow sending rate exists to avoid.
ALTER TYPE "MessageKind" ADD VALUE IF NOT EXISTS 'STOP_OK';
