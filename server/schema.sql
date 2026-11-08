-- Birdman Picks server database (Cloudflare D1).
-- Apply with: npx wrangler d1 execute birdman --remote --file=schema.sql

-- Birdman's published picks. Rows are only ever added; the server fills in the close and result.
CREATE TABLE IF NOT EXISTS picks (
  seq INTEGER PRIMARY KEY,           -- 1, 2, 3… in posting order
  id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,       -- server clock, ms
  start_at INTEGER NOT NULL,         -- game start, ms
  league TEXT NOT NULL,
  event_id TEXT NOT NULL,
  date TEXT NOT NULL,
  matchup TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  line REAL,
  odds INTEGER NOT NULL,
  selection TEXT NOT NULL,
  player TEXT,
  stat TEXT,
  units REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'owner', -- 'owner' or 'model' (the pick agent)
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  final_score TEXT,
  margin REAL,
  close_odds INTEGER,
  close_line REAL,
  close_checked INTEGER NOT NULL DEFAULT 0,
  graded_at INTEGER
);
CREATE INDEX IF NOT EXISTS picks_open ON picks (status, start_at);

-- Free pick'em pools: friends pick game winners, no money and no prizes.
CREATE TABLE IF NOT EXISTS pools (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  league TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  pool_id INTEGER NOT NULL REFERENCES pools(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  joined_at INTEGER NOT NULL,
  UNIQUE (pool_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS entries (
  member_id INTEGER NOT NULL REFERENCES members(id),
  pool_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  league TEXT NOT NULL,
  date TEXT NOT NULL,
  side TEXT NOT NULL,
  label TEXT NOT NULL,
  matchup TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  result TEXT,                       -- null until graded: 'right', 'wrong' or 'void'
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, event_id)
);
CREATE INDEX IF NOT EXISTS entries_pool ON entries (pool_id, date);
CREATE INDEX IF NOT EXISTS entries_open ON entries (result, start_at);

-- Pro: restore-by-email codes and a simple per-email send limit.
CREATE TABLE IF NOT EXISTS restore_codes (
  email_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  customer TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL
);

-- Separate append-only Pro research history. Never merged into picks or browser ledgers.
CREATE TABLE IF NOT EXISTS scout_reports (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, report TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scout_reports_time ON scout_reports(created_at);

CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,               -- sha256 of the push endpoint
  endpoint TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL,           -- sha256 of the subscription's auth secret; the phone proves itself with it
  customer TEXT NOT NULL,            -- Stripe customer, checked when the app (re)subscribes
  picks INTEGER NOT NULL DEFAULT 1,  -- wants new-pick alerts
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  fails INTEGER NOT NULL DEFAULT 0,
  pro_until INTEGER NOT NULL DEFAULT 0 -- alerts stop after this (the paid period's end); refreshed when the app opens
);
CREATE TABLE IF NOT EXISTS push_follows (
  sub_id TEXT NOT NULL,
  pick_id TEXT NOT NULL,
  odds INTEGER NOT NULL,             -- the last price this member was told about
  line REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sub_id, pick_id)
);
CREATE INDEX IF NOT EXISTS push_follows_pick ON push_follows (pick_id);
CREATE TABLE IF NOT EXISTS push_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  tag TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_outbox_sub ON push_outbox (sub_id, sent, delivered);
CREATE TABLE IF NOT EXISTS push_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Players' own verified records, which double as the free weekly contest (1,000 pretend points a week).
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,     -- lowercase name, so names are unique however they're typed
  token_hash TEXT NOT NULL,          -- sha256 of the device sign-in token; the token itself is never stored
  created_at INTEGER NOT NULL,
  brand_until INTEGER NOT NULL DEFAULT 0  -- stream overlay shows without Birdman branding until then (Pro)
);
-- Rows are only ever added; the server fills in the close and result. Same hash chain as picks, one per player.
CREATE TABLE IF NOT EXISTS user_picks (
  player_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  league TEXT NOT NULL,
  event_id TEXT NOT NULL,
  date TEXT NOT NULL,
  matchup TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  line REAL,
  odds INTEGER NOT NULL,
  selection TEXT NOT NULL,
  player TEXT,
  stat TEXT,
  units REAL NOT NULL,               -- contest points staked
  reason TEXT NOT NULL DEFAULT '',
  week TEXT NOT NULL,                -- contest week (Monday, Eastern)
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  final_score TEXT,
  margin REAL,
  close_odds INTEGER,
  close_line REAL,
  close_checked INTEGER NOT NULL DEFAULT 0,
  clv_beat INTEGER,                  -- 1 beat the closing line, 0 didn't, NULL not measured
  graded_at INTEGER,
  UNIQUE (player_id, seq)
);
CREATE INDEX IF NOT EXISTS user_picks_open ON user_picks (status, start_at);
CREATE INDEX IF NOT EXISTS user_picks_week ON user_picks (week, player_id);

-- Pro injury alerts: players in a member's open bets and lineups, and the last injury status seen for each.
CREATE TABLE IF NOT EXISTS push_watch (
  sub_id TEXT NOT NULL,
  league TEXT NOT NULL,
  player_key TEXT NOT NULL,          -- normalized name
  label TEXT NOT NULL,               -- what it's in, e.g. the bet or lineup
  until INTEGER NOT NULL,
  PRIMARY KEY (sub_id, league, player_key)
);
CREATE INDEX IF NOT EXISTS push_watch_player ON push_watch (league, player_key);
CREATE TABLE IF NOT EXISTS injury_state (
  league TEXT NOT NULL,
  player_key TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (league, player_key)
);

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
