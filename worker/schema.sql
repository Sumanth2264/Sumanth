CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  movie TEXT NOT NULL,
  city TEXT,
  theatres TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  format TEXT,
  time_pref TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  manage_token TEXT NOT NULL UNIQUE,
  provider TEXT DEFAULT 'District',
  provider_movie_id TEXT DEFAULT '',
  provider_movies TEXT DEFAULT '{}',
  date_pref TEXT DEFAULT 'Any date',
  specific_date TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  delivered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);