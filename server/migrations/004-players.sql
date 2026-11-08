-- Verified records for everyone, the weekly contest, and Pro injury alerts. Additive; safe to run more than once.
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
