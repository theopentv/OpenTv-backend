-- Which TV Time comment an imported row WAS, and which one it answered.
--
-- TV Time's export links a reply to its parent (`episode_comment.csv`:
-- `id` / `parent_comment_id`; `comments-prod-comments.csv`: `uuid` /
-- `parent_uuid`), and the import used to throw the link away, so every reply
-- stood in its thread as a top-level comment. The parent is usually somebody
-- ELSE's comment, which reaches this server only when that person imports — so
-- the link has to be kept until then, not resolved once and dropped.
--
-- The values carry their id space as a prefix ('e:28320931' for the legacy
-- episode file, 'c:<uuid>' for the current one), so the two numbering systems
-- can never name each other's rows. Both NULL for anything written in the app.
--
-- These are TV Time's ids for the user's OWN comments — the same thing the
-- comment row already is — not a new fact about anybody.
ALTER TABLE comments ADD COLUMN tvtime_id TEXT;
ALTER TABLE comments ADD COLUMN tvtime_parent_id TEXT;

-- "Is this reply's parent here?" at import time.
CREATE INDEX IF NOT EXISTS idx_comments_tvtime_id
  ON comments (tvtime_id)
  WHERE tvtime_id IS NOT NULL;

-- "Which replies answer the comment that just arrived?" — the adopt step.
-- Partial, like idx_comments_parent: only imported replies carry the column.
CREATE INDEX IF NOT EXISTS idx_comments_tvtime_parent
  ON comments (tvtime_parent_id)
  WHERE tvtime_parent_id IS NOT NULL;
