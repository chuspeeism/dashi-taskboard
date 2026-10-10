// Story points of the synced Linear cycle. Parents pulled in only for context
// (inScope false) and canceled issues do not count toward the cycle.
export function sprintPoints(tasks) {
  const byStatus = {};
  let total = 0;
  let completed = 0;
  for (const task of tasks) {
    if (task.inScope !== true || task.estimate === null || task.estimate === undefined) continue;
    byStatus[task.status] = (byStatus[task.status] ?? 0) + task.estimate;
    if (task.status === "canceled") continue;
    total += task.estimate;
    if (task.status === "done") completed += task.estimate;
  }
  return { total, completed, remaining: total - completed, byStatus };
}
