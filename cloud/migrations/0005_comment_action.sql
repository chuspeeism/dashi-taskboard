ALTER TABLE comments ADD COLUMN action TEXT NOT NULL DEFAULT 'comment' CHECK (action IN ('comment', 'review', 'development', 'discussion'));
UPDATE comments SET action = CASE WHEN intent = 'discussion' THEN 'discussion' WHEN intent = 'resume' AND ai_thread_id IS NOT NULL THEN 'development' WHEN intent = 'resume' THEN 'review' ELSE 'comment' END;
