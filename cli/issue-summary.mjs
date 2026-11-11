// Read-only output projection. The description remains the source of truth.
const INDEX_FIELDS = [
  "id", "identifier", "projectId", "title", "status", "priority", "labels",
  "version", "updatedAt", "threadId", "threadBinding", "legacyLocalThreadId",
  "agentSession", "developmentContext", "archivedAt", "relations",
];
const LABELS = { "目标": "goal", "当前进展": "progress", "下一步": "next" };

export function projectIssueSummary(task) {
  const summary = { goal: null, progress: null, next: null };
  // Only explicit one-line fields at the beginning count. Never search details/history.
  for (const line of (task.description ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^(?:\*\*(目标|当前进展|下一步)[：:]\*\*|(?:目标|当前进展|下一步)[：:])\s*(.*)$/);
    if (!match) break;
    const label = match[1] ?? line.slice(0, line.search(/[：:]/));
    const key = LABELS[label];
    if (summary[key] !== null) break;
    summary[key] = match[2].trim() || null;
    if (Object.values(summary).every(value => value !== null)) break;
  }
  const summaryComplete = Object.values(summary).every(value => value !== null);
  return {
    ...Object.fromEntries(INDEX_FIELDS.filter(key => key in task).map(key => [key, task[key]])),
    summary,
    summaryComplete,
    ...(!summaryComplete ? { summaryHint: "摘要缺段或为旧格式；请用 --view full 深读，不要推测缺失内容。" } : {}),
  };
}
