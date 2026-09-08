// Select both endpoints once per ID batch; the outer order also interleaves
// incoming and outgoing "related" edges in the original task order.
export function taskRelationsQuery(placeholders) {
  return `
    WITH selected_tasks AS (
      SELECT id FROM tasks WHERE id IN (${placeholders})
    ), relation_targets AS (
      SELECT
        selected_tasks.id AS task_id,
        task_relations.target_task_id AS related_task_id,
        CASE task_relations.relation_type
          WHEN 'parent' THEN 'subIssues'
          WHEN 'blocks' THEN 'blocks'
          WHEN 'related' THEN 'related'
        END AS relation_field
      FROM selected_tasks
      JOIN task_relations ON task_relations.source_task_id = selected_tasks.id
      UNION ALL
      SELECT
        selected_tasks.id AS task_id,
        task_relations.source_task_id AS related_task_id,
        CASE task_relations.relation_type
          WHEN 'parent' THEN 'parent'
          WHEN 'blocks' THEN 'blockedBy'
          WHEN 'related' THEN 'related'
        END AS relation_field
      FROM selected_tasks
      JOIN task_relations ON task_relations.target_task_id = selected_tasks.id
    )
    SELECT tasks.*, relation_targets.task_id AS relation_task_id, relation_targets.relation_field
    FROM relation_targets
    JOIN tasks ON tasks.id = relation_targets.related_task_id
    ORDER BY tasks.sort_order, tasks.created_at, tasks.id
  `;
}

export function taskRelationsFromRows(taskIds, rows, summarizeTask) {
  const relationsByTask = new Map(taskIds.map((taskId) => [taskId, {
    parent: null,
    subIssues: [],
    blockedBy: [],
    blocks: [],
    related: [],
  }]));
  for (const row of rows) {
    const relations = relationsByTask.get(row.relation_task_id);
    const summary = summarizeTask(row);
    if (row.relation_field === "parent") {
      relations.parent = summary;
    } else {
      relations[row.relation_field].push(summary);
    }
  }
  return relationsByTask;
}
