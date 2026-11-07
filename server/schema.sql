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
