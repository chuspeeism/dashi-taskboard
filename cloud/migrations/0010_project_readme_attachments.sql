CREATE TABLE IF NOT EXISTS project_readme_attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL
);

CREATE TRIGGER project_readme_attachments_revision_insert
AFTER INSERT ON project_readme_attachments
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER project_readme_attachments_revision_delete
AFTER DELETE ON project_readme_attachments
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
