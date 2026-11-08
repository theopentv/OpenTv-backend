-- Words that did not go to CommsUni because the check before sending (§A11.1
-- of the partner terms) held them: a link, a Llama Guard "unsafe", or a check
-- that could not run. A held comment stays on OpenTV; a held reply was refused.
-- The dashboard lists the open ones; a comment can be released from there.
CREATE TABLE IF NOT EXISTS commsuni_held (
  id          TEXT PRIMARY KEY,              -- our comment id (share) or the client id (reply)
  kind        TEXT NOT NULL,                 -- 'share' | 'reply'
  profile_id  TEXT NOT NULL,
  body        TEXT NOT NULL,
  reason      TEXT NOT NULL,                 -- 'link' | 'unsafe:<categories>' | 'check_failed'
  meta        TEXT,                          -- JSON: what a release needs (tvdb_movie / parent)
  created_at  TEXT NOT NULL,
  resolved    TEXT,                          -- NULL open | 'released' | 'dismissed'
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS commsuni_held_open ON commsuni_held (resolved, created_at);
