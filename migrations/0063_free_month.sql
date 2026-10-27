-- A FREE MONTH OF PLUS FOR SIGNING IN (2.0.3). Every account gets thirty days
-- of Plus once, written into `plus_until` -- the same hand-grant lane gifting
-- uses, so it expires on its own with nothing to revoke and no store trial.
--
-- `free_month_at` is ONCE PER ACCOUNT: when this profile took its month.
-- `heard_from` is the one sign-up question, "Where did you hear about OpenTV?",
-- and holds a SHAPE only: one of reddit / store / friend / creator / other.
-- Never a subreddit, a creator's name or free text -- the answer to "which
-- channel works" needs nothing that identifies one person's path.
ALTER TABLE profiles ADD COLUMN free_month_at TEXT;
ALTER TABLE profiles ADD COLUMN heard_from TEXT;

-- ONCE PER PERSON, which a profile alone cannot say. DELETE /v1/me removes the
-- identity rows on purpose ("signing in again must create a NEW profile"), so
-- delete-and-sign-in-again would otherwise be a free month every thirty days.
-- Each row is an HMAC of `provider:subject` under SESSION_SECRET -- the Apple
-- or Google subject, or the address for an email account -- so the table can
-- answer "has this sign-in had its month?" and nothing else: it cannot be
-- turned back into an address or an id, holds no profile id, and survives
-- account deletion because surviving it is its only job.
CREATE TABLE IF NOT EXISTS free_month_claims (
  subject_hash TEXT PRIMARY KEY,
  claimed_at   TEXT NOT NULL
);
