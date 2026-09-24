CREATE TABLE IF NOT EXISTS alerts (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL,
 movie TEXT NOT NULL,
 city TEXT NOT NULL,
 theatres TEXT NOT NULL DEFAULT '[]',
 language TEXT NOT NULL DEFAULT 'Any',
 format TEXT NOT NULL DEFAULT 'Any',
 time_pref TEXT NOT NULL DEFAULT 'Any time',
 date_pref TEXT NOT NULL DEFAULT 'Any date',
 sources TEXT NOT NULL DEFAULT '[]',
 manage_token TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'ARMED',
 created_at INTEGER NOT NULL,
 last_match_key TEXT NOT NULL DEFAULT '',
 last_match_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_email ON alerts(email);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_movie_city ON alerts(movie, city);