-- One row per person per day they uploaded a backup, for the dashboard's
-- "Plus in use" chart (15 Oct 2026). profiles.backup_at only keeps the latest
-- upload, so a day's count could not be read back from it. Never what was
-- backed up, only that someone did on that day; pruned at 90 days like
-- profile_days.
CREATE TABLE IF NOT EXISTS backup_days (
  profile_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  PRIMARY KEY (profile_id, day)
);
