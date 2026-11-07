
-- Separate append-only Pro research history. Never merged into picks or browser ledgers.
CREATE TABLE IF NOT EXISTS scout_reports (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, report TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scout_reports_time ON scout_reports(created_at);
