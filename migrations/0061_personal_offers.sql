-- A PERSONAL OFFER (17 Oct 2026): the dashboard's "Give offer". One person,
-- one store offer, one real end. The phone's paywall shows it with a countdown
-- to `ends_at` and buys through the store offer `offer_id` names (an Apple
-- promotional offer id, or a Google Play offer id / tag on the base plan).
--
-- The primary key is the promise Apple's guideline cares about: the same offer
-- can never be given to the same person twice, so a countdown that ran out
-- cannot quietly start again. Ended rows stay for exactly that reason.
--
-- Nothing about money is kept here — no price, no product, no receipt. The
-- store knows those; this only says which offer, until when, and whether it
-- was used. `label` is Mahmood's own note for the dashboard and never reaches
-- the phone.
CREATE TABLE IF NOT EXISTS personal_offers (
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  offer_id    TEXT NOT NULL,
  label       TEXT,
  ends_at     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (profile_id, offer_id)
);
