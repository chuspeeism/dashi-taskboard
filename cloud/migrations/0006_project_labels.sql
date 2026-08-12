ALTER TABLE projects
ADD COLUMN labels TEXT NOT NULL DEFAULT '["缺陷","特性","for-claude","hold","改进","phase-1","phase-2","phase-3","phase-4","phase-5","phase-6"]';

WITH catalog AS (
  SELECT
    projects.id AS project_id,
    default_labels.value AS label,
    0 AS source_order,
    printf('%08d', default_labels.key) AS label_order
  FROM projects, json_each('["缺陷","特性","for-claude","hold","改进","phase-1","phase-2","phase-3","phase-4","phase-5","phase-6"]') AS default_labels

  UNION ALL

  SELECT
    tasks.project_id,
    task_labels.value,
    1,
    tasks.created_at || ':' || tasks.id || ':' || printf('%08d', task_labels.key)
  FROM tasks, json_each(tasks.labels) AS task_labels
)
UPDATE projects
SET labels = (
  SELECT json_group_array(label)
  FROM (
    SELECT label
    FROM catalog
    WHERE catalog.project_id = projects.id
    GROUP BY label
    ORDER BY MIN(source_order), MIN(label_order)
  )
);
