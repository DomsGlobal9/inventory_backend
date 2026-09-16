-- Ending sign-ins that should no longer work.
--
-- A sign-in token lasted its full 24 hours (8 for the platform console) whatever happened in the
-- meantime: after a password was reset because it had leaked, the old token -- copied, or on a lost
-- phone -- kept working. Every token now carries the account's session number, and raising the number
-- ends every sign-in issued before it.
--
-- Only ADDS a column, defaulting to 0. Tokens issued before this carry no number and are read as 0,
-- so nobody is signed out by the deploy itself.
ALTER TABLE "users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "platform_admins" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
