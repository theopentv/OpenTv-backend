-- 2.3.0: the 6-digit codes that link Claude / ChatGPT to an account.
-- In D1, not KV: KV caches a lookup of a key that does not exist yet for up
-- to a minute, so the collision check before writing a code made that code
-- read as "wrong" for the next minute (4 Nov, the first real try). D1 is read
-- what it was written, and DELETE ... RETURNING makes a code work once.
CREATE TABLE IF NOT EXISTS mcp_codes (
  code       TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_codes_profile ON mcp_codes (profile_id);
