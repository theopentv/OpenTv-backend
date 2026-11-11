-- 2.4.0: three columns, one migration.

-- 1. FREE FIRST ONE, AND DELETING DOES NOT REFUND IT. A list somebody else
--    ever joined has been used, so it keeps counting against the free first
--    one after it is deleted; a list nobody joined was only ever a draft.
--    Set on a non-owner join, never cleared. Backfilled from today's members
--    (a soft-deleted list keeps its member rows, so old ones count too).
ALTER TABLE shared_lists ADD COLUMN was_shared INTEGER NOT NULL DEFAULT 0;
UPDATE shared_lists SET was_shared = 1
 WHERE EXISTS (SELECT 1 FROM shared_list_members m WHERE m.list_id = shared_lists.id AND m.role = 'member');

-- 2. "MARK IT FOR BOTH OF US": each member's own switch on a together. Only
--    when every member has it on does a phone copy the others' positions into
--    its own library — the server stores the switch, never an episode.
ALTER TABLE shared_list_members ADD COLUMN mark_together INTEGER NOT NULL DEFAULT 0;

-- 3. WHERE A LIBRARY CAME FROM — one word from a fixed set (tvtime, simkl, ...),
--    sent with a publish. Which app somebody left, never what was in it.
ALTER TABLE profiles ADD COLUMN import_source TEXT;
