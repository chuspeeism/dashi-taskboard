// The team counts sprint points by the sprint label (for example
// "1.82.0 (Sprint 92)"), while the board counts by cycle membership. Flags
// in-scope tasks of the selected cycle that do not carry that sprint's label.
// cycleName is the selected cycle's name; null ("all" cycles) flags nothing.
export function missingSprintLabels(tasks, cycleName) {
  const match = /Sprint\s+(\d+)/i.exec(cycleName ?? "");
  if (!match) return null;
  const sprintNumber = Number(match[1]);
  const marker = `(Sprint ${sprintNumber})`;
  const hasMarker = (label) => label.includes(marker);
  const counts = new Map();
  const taskIds = new Set();
  let points = 0;
  for (const task of tasks) {
    if (task.inScope !== true) continue;
    const sprintLabels = task.labels.filter(hasMarker);
    for (const label of sprintLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
    if (sprintLabels.length > 0) continue;
    taskIds.add(task.id);
    points += task.estimate ?? 0;
  }
  let suggestedLabel = `<version> ${marker}`;
  let best = 0;
  for (const [label, count] of counts) {
    if (count > best) {
      suggestedLabel = label;
      best = count;
    }
  }
  return { sprintNumber, suggestedLabel, taskIds, points };
}
