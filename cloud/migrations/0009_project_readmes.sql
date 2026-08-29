CREATE TABLE IF NOT EXISTS project_readmes (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER project_readmes_revision_insert
AFTER INSERT ON project_readmes
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER project_readmes_revision_update
AFTER UPDATE ON project_readmes
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER project_readmes_revision_delete
AFTER DELETE ON project_readmes
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
