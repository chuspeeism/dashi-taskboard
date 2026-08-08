ALTER TABLE comments ADD COLUMN ai_thread_id TEXT;
ALTER TABLE comments ADD COLUMN intent TEXT NOT NULL DEFAULT 'comment'
  CHECK (intent IN ('comment', 'resume', 'discussion'));
