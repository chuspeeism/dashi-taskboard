ALTER TABLE comments
  ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE attachments
  ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER comments_revision_insert;

CREATE TRIGGER comments_revision_insert AFTER INSERT ON comments BEGIN
  UPDATE global_revision
  SET revision = MAX(revision + 1, NEW.change_revision)
  WHERE singleton = 1;
END;

DROP TRIGGER attachments_revision_insert;

CREATE TRIGGER attachments_revision_insert AFTER INSERT ON attachments BEGIN
  UPDATE global_revision
  SET revision = MAX(revision + 1, NEW.change_revision)
  WHERE singleton = 1;
END;

CREATE INDEX comments_task_change_revision
  ON comments(task_id, change_revision);

CREATE INDEX attachments_task_change_revision
  ON attachments(task_id, comment_id, change_revision);

CREATE INDEX attachments_comment_change_revision
  ON attachments(comment_id, change_revision);
