CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  request_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  context_json TEXT NOT NULL DEFAULT '{}',
  response_text TEXT,
  response_status INTEGER,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_request_key
  ON generation_jobs (request_key, created_at);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_status
  ON generation_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error TEXT
);
