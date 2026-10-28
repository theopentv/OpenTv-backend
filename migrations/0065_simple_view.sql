-- SIMPLE VIEW (2.0.4). The owner turned on Settings → Simple view, which keeps
-- their own stats to counts; this carries the same choice to everybody else.
-- 1 = the published profile sends no numbers, only that the owner chose this,
-- and the app draws a lock where the stats would be. Set on every publish from
-- what the phone says, so turning it off is simply the next publish.
ALTER TABLE profile_stats ADD COLUMN simple_view INTEGER NOT NULL DEFAULT 0;
