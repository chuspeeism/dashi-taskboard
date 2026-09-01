DROP TRIGGER workflow_workspaces_revision_insert;
DROP TRIGGER workflow_workspaces_revision_update;
DROP TRIGGER workflow_workspaces_revision_delete;
DROP TABLE workflow_workspaces;
ALTER TABLE tasks DROP COLUMN workflow_id;
