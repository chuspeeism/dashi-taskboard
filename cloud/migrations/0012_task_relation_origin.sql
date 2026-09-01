ALTER TABLE task_relations
ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
CHECK (origin IN ('manual', 'mention'));
