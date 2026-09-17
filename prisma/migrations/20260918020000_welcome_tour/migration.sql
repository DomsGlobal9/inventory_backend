-- A short tour of the app, shown once to somebody who has never seen it.
--
-- "Never seen it" has to be remembered on the account, not in the browser: a shop owner who opens
-- ScaleEzy on the counter computer, then on their phone, is not a new user twice, and clearing the
-- browser must not start the tour again.
--
-- Only ADDS a nullable column. Everybody who exists today has never been shown the tour, which is
-- exactly what NULL means, so they are offered it once on their next visit.
ALTER TABLE "users" ADD COLUMN "tour_seen_at" TIMESTAMP(3);
