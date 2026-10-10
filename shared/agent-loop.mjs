// Agent loop rules shared by `taskctl next`, `taskctl loop config` and the web UI.

export const AGENT_LOOP_STORAGE_KEY = "taskboard.agentLoop.v1";
export const DEFAULT_MAX_CONCURRENT = 2;
export const MAX_CONCURRENT_LIMIT = 10;
// An agent comment starting with this marker asks the user for a decision.
export const DECISION_REQUEST_MARKER = "[decision-request]";
// A user comment starting with this marker on an in_review task asks for rework.
export const REWORK_MARKER = "/rework";

const KIND_RANK = { resume: 0, rework: 1, new: 2 };
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export function parseAgentLoopSettings(raw) {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function projectLoopSettings(settings, projectId) {
  const value = settings?.[projectId];
  const maxConcurrent = Number.isInteger(value?.maxConcurrent)
    && value.maxConcurrent >= 1
    && value.maxConcurrent <= MAX_CONCURRENT_LIMIT
    ? value.maxConcurrent
    : DEFAULT_MAX_CONCURRENT;
  const repoPath = typeof value?.repoPath === "string" && value.repoPath ? value.repoPath : null;
  const labelRepos = value?.labelRepos && typeof value.labelRepos === "object" && !Array.isArray(value.labelRepos)
    ? Object.fromEntries(Object.entries(value.labelRepos).filter(([, path]) => typeof path === "string" && path))
    : {};
  return { enabled: value?.enabled === true, maxConcurrent, repoPath, labelRepos };
}

// The repository an agent works in for this task: the first label override, else the default.
export function repoForTask(settings, task) {
  const label = task?.labels?.find((name) => Object.hasOwn(settings.labelRepos, name));
  return label ? settings.labelRepos[label] : settings.repoPath;
}

export function isAgentWorking(task) {
  return task.status === "in_progress"
    && Boolean(task.agentSession || task.threadBinding || task.threadId);
}

function startsWithMarker(comment, marker) {
  return typeof comment?.body === "string" && comment.body.trimStart().startsWith(marker);
}

// "none" | "waiting" | "answered": the latest agent decision request and
// whether the user has commented after it. Comments are oldest first.
export function decisionState(comments) {
  let requestIndex = -1;
  comments.forEach((comment, index) => {
    if (comment.authorType === "agent" && startsWithMarker(comment, DECISION_REQUEST_MARKER)) {
      requestIndex = index;
    }
  });
  if (requestIndex === -1) return "none";
  return comments.slice(requestIndex + 1).some((comment) => comment.authorType === "user")
    ? "answered"
    : "waiting";
}

// A user /rework comment that no agent comment has followed yet.
export function reworkRequested(comments) {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (comment.authorType === "agent") return false;
    if (startsWithMarker(comment, REWORK_MARKER)) return true;
  }
  return false;
}

export function candidateKind(task, comments) {
  if (task.archivedAt) return null;
  const decision = decisionState(comments);
  if (task.status === "blocked") return decision === "answered" ? "resume" : null;
  if (task.status === "in_review") return reworkRequested(comments) ? "rework" : null;
  if (task.status !== "todo" || decision === "waiting") return null;
  if (task.labels?.includes("hold")) return null;
  const blockers = task.relations?.blockedBy ?? [];
  return blockers.every((blocker) => blocker.status === "done") ? "new" : null;
}

// Tasks whose comments decide eligibility; the caller fetches comments for these only.
export function needsComments(task) {
  return !task.archivedAt && ["todo", "blocked", "in_review"].includes(task.status);
}

export function rankCandidates(tasks, commentsByTaskId) {
  return tasks
    .flatMap((task) => {
      if (!needsComments(task)) return [];
      const kind = candidateKind(task, commentsByTaskId.get(task.id) ?? []);
      return kind ? [{ task, kind }] : [];
    })
    .sort((left, right) => (
      KIND_RANK[left.kind] - KIND_RANK[right.kind]
      || (PRIORITY_RANK[left.task.priority] ?? 4) - (PRIORITY_RANK[right.task.priority] ?? 4)
      || left.task.sortOrder - right.task.sortOrder
    ));
}
