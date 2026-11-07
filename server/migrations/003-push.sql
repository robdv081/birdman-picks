-- Pro phone alerts (Web Push). Additive; safe to run more than once.
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
