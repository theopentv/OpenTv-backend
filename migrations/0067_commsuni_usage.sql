-- What OpenTV asks of CommsUni, per day. Reads are billed, and the only other
-- place this number exists is their meter. Calls that reach them, not page
-- views: a cache hit costs nothing and is not counted. No user, no title: a
-- day's totals are all a bill needs.
CREATE TABLE IF NOT EXISTS commsuni_usage (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
