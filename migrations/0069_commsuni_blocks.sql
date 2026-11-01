-- CommsUni authors a member has blocked (Partner Terms §A11.4, guide "Blocking
-- authors"). Keyed by the API's `userId`, kept here so a block follows the
-- member to every device. App-scoped: CommsUni is never told. The name is
-- only so the member can recognise the row when reviewing their blocks.
CREATE TABLE IF NOT EXISTS commsuni_blocks (
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, author_id)
);
