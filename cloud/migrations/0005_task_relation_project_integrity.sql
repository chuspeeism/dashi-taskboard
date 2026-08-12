CREATE TRIGGER task_relations_require_same_project
BEFORE INSERT ON task_relations
BEGIN
  SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION')
  WHERE EXISTS (
    SELECT 1
    FROM tasks AS source
    JOIN tasks AS target ON target.id = NEW.target_task_id
    WHERE source.id = NEW.source_task_id
      AND source.project_id != target.project_id
  );
END;
