CREATE TABLE task_intervention_overrides (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  view TEXT NOT NULL CHECK (view IN ('resolve', 'follow_up', 'comment')),
  mode TEXT NOT NULL CHECK (mode IN ('include', 'exclude')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, view)
);
CREATE INDEX task_intervention_overrides_updated
  ON task_intervention_overrides(updated_at, task_id);
CREATE TRIGGER task_intervention_overrides_revision_insert
AFTER INSERT ON task_intervention_overrides
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER task_intervention_overrides_revision_update
AFTER UPDATE ON task_intervention_overrides
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER task_intervention_overrides_revision_delete
AFTER DELETE ON task_intervention_overrides
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
