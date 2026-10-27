-- HOW THE FREE MONTH ARRIVED (2.0.3). NULL is the month the app claimed after a
-- sign-in (`POST /v1/me/free-month`); 'gift' is the dashboard's "Give everyone
-- a month", which reached accounts that existed before 2.0.3 without them
-- asking. Two readers: the phone, which shows "A month of Plus is yours" once
-- for a gift because nobody tapped anything to expect it, and the dashboard,
-- which counts the two lanes apart. A shape, never a reason or a name.
ALTER TABLE profiles ADD COLUMN free_month_via TEXT;
