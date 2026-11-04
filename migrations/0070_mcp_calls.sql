-- How often Claude and ChatGPT use OpenTV's MCP tools, for the dashboard (2.3.0).
--
-- SHAPE, NEVER CONTENT: a member, a day, which tool, which assistant, how many
-- times. No arguments, no titles, no questions and no answers -- there is no
-- column that could hold one, so this cannot become a watch history. `client`
-- is "Claude", "ChatGPT" or "Other", read from the grant's client, never the
-- free-text name it registered with. Pruned per member at 500 days on write,
-- like profile_days and backup_days; deleted with the account.
CREATE TABLE IF NOT EXISTS mcp_calls (
  profile_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  tool       TEXT NOT NULL,
  client     TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, day, tool, client)
);
CREATE INDEX IF NOT EXISTS mcp_calls_day ON mcp_calls (day);
