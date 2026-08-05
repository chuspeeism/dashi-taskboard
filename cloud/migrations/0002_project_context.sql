CREATE TABLE project_context_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'requirement', 'decision', 'constraint', 'fact', 'risk', 'handoff', 'summary'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 65536),
  tags TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags) = 1 AND json_type(tags) = 'array'),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'manual', 'issue', 'comment', 'thread_summary', 'agent'
  )),
  source_id TEXT,
  source_thread_id TEXT,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX project_context_entries_project_idempotency
  ON project_context_entries(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX project_context_entries_project_page
  ON project_context_entries(project_id, archived_at, created_at DESC, id DESC);

CREATE INDEX project_context_entries_project_kind
  ON project_context_entries(project_id, archived_at, kind, created_at DESC, id DESC);

CREATE INDEX project_context_entries_project_pinned
  ON project_context_entries(project_id, archived_at, pinned DESC, updated_at DESC, id);

CREATE TABLE project_context_revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES project_context_entries(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 65536),
  kind TEXT NOT NULL CHECK (kind IN (
    'requirement', 'decision', 'constraint', 'fact', 'risk', 'handoff', 'summary'
  )),
  tags TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags) = 1 AND json_type(tags) = 'array'),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX project_context_revisions_entry_version_unique
  ON project_context_revisions(entry_id, version);

CREATE INDEX project_context_revisions_entry_versions
  ON project_context_revisions(entry_id, version DESC);

CREATE TRIGGER project_context_entries_global_revision_insert
AFTER INSERT ON project_context_entries
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER project_context_entries_global_revision_update
AFTER UPDATE ON project_context_entries
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER project_context_entries_global_revision_delete
AFTER DELETE ON project_context_entries
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
