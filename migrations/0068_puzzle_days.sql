-- One row per member per day they finished the daily puzzle, for the dashboard.
-- How it went, never what the answer was: no title and no id, so this cannot
-- become a watch history. Kept 90 days, like profile_days and backup_days.
CREATE TABLE IF NOT EXISTS puzzle_days (
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  won        INTEGER NOT NULL,
  tries      INTEGER NOT NULL,
  streak     INTEGER NOT NULL,
  PRIMARY KEY (profile_id, day)
);
CREATE INDEX IF NOT EXISTS puzzle_days_day ON puzzle_days (day);
