CREATE TABLE task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_avatar_url TEXT,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX task_activities_task_created
  ON task_activities(task_id, created_at, id);

CREATE TRIGGER task_activities_revision_insert
AFTER INSERT ON task_activities
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER task_activities_revision_update
AFTER UPDATE ON task_activities
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER task_activities_revision_delete
AFTER DELETE ON task_activities
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
