INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
VALUES (
  'local',
  '全局',
  NULL,
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(id) DO NOTHING;

UPDATE projects
SET
  name = '全局',
  workspace_path = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL);
