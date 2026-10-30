-- ONCE PER CAMPAIGN (2.1.0), not once for life: somebody who took a month in an
-- earlier window may take the Christmas one. `free_month_at` keeps saying when
-- this profile last took a month; this says for which campaign. NULL is a month
-- from before campaigns, which no campaign counts as its own. The per-person
-- guard needs no column: `free_month_claims` hashes now include the campaign.
ALTER TABLE profiles ADD COLUMN free_month_campaign TEXT;
