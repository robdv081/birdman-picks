-- Visit and action counts for the owner's Stats page. Daily totals only: no cookies, IPs or per-person rows.
CREATE TABLE IF NOT EXISTS visits (
  day TEXT NOT NULL,                 -- Eastern date
  source TEXT NOT NULL,              -- tiktok, google, direct, ...
  medium TEXT NOT NULL,              -- social, search, referral, link, none
  campaign TEXT NOT NULL,            -- link tag, or '-'
  landing TEXT NOT NULL,             -- first page: today, compete, player, record, ...
  device TEXT NOT NULL,              -- mobile, desktop, tablet, app (home-screen), other
  repeat_visit INTEGER NOT NULL,      -- 1 if this browser had visited before
  n INTEGER NOT NULL,
  PRIMARY KEY (day, source, medium, campaign, landing, device, repeat_visit)
);
CREATE TABLE IF NOT EXISTS events (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,                -- player_created, player_pick, pro_claim, alerts_on
  n INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);
