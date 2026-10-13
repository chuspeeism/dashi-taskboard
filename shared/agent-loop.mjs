// Agent loop rules shared by `taskctl next`, `taskctl loop config` and the web UI.

import { linearQaState } from "./linear-states.mjs";

export const AGENT_LOOP_STORAGE_KEY = "taskboard.agentLoop.v1";
export const DEFAULT_MAX_CONCURRENT = 2;
export const MAX_CONCURRENT_LIMIT = 10;
// An agent comment starting with this marker asks the user for a decision.
export const DECISION_REQUEST_MARKER = "[decision-request]";
// A user comment starting with this marker on an in_review task asks for rework.
export const REWORK_MARKER = "/rework";
// An agent comment starting with this marker records that the issue's PR is merged.
export const MERGED_MARKER = "[merged]";

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
  // earlyAnalysis (Linear): also sync my next-cycle Defining Requirements issues for early analysis.
  return { enabled: value?.enabled === true, maxConcurrent, repoPath, labelRepos, earlyAnalysis: value?.earlyAnalysis === true };
}

// The repository an agent works in for this task: the first label override, else the default.
export function repoForTask(settings, task) {
  const label = task?.labels?.find((name) => Object.hasOwn(settings.labelRepos, name));
  return label ? settings.labelRepos[label] : settings.repoPath;
}

// Paused tasks, resumed tasks no agent has claimed again yet, and Linear tasks
// waiting on QA do not count toward maxConcurrent.
export function isAgentWorking(task) {
  return task.status === "in_progress"
    && !task.pausedAt
    && !task.resumedAt
    && !linearQaState(task)
    && Boolean(task.agentSession || task.threadBinding || task.threadId);
}

function startsWithMarker(comment, marker) {
  return typeof comment?.body === "string" && comment.body.trimStart().startsWith(marker);
}

// An agent keeps one comment per ticket and edits it, so its last edit time,
// not its position in the list, says when the agent last spoke.
function editedAt(comment) {
  return comment.updatedAt ?? comment.createdAt ?? "";
}

// "none" | "waiting" | "answered": the latest agent decision request and
// whether the user has commented after its last edit.
export function decisionState(comments) {
  let request = null;
  for (const comment of comments) {
    if (
      comment.authorType === "agent"
      && startsWithMarker(comment, DECISION_REQUEST_MARKER)
      && (!request || editedAt(comment) >= editedAt(request))
    ) {
      request = comment;
    }
  }
  if (!request) return "none";
  return comments.some((comment) => comment.authorType === "user" && comment.createdAt > editedAt(request))
    ? "answered"
    : "waiting";
}

// The latest user /rework comment, unless an agent comment was written or edited after it.
export function reworkRequested(comments) {
  const rework = comments.findLast((comment) => comment.authorType === "user" && startsWithMarker(comment, REWORK_MARKER));
  if (!rework) return false;
  return !comments.some((comment) => comment.authorType === "agent" && editedAt(comment) > rework.createdAt);
}

// A blocker stops blocking once it is done, or in review with a merged PR.
function blockerSatisfied(blocker, commentsByTaskId) {
  if (blocker.status === "done") return true;
  return blocker.status === "in_review" && (commentsByTaskId.get(blocker.id) ?? []).some(
    (comment) => comment.authorType === "agent" && startsWithMarker(comment, MERGED_MARKER),
  );
}

export function candidateKind(task, comments, commentsByTaskId = new Map()) {
  if (task.archivedAt) return null;
  // The user pressed Resume on a paused task: hand it out again until an agent claims it.
  if (task.status === "in_progress") return task.resumedAt && !task.pausedAt ? "resume" : null;
  const decision = decisionState(comments);
  if (task.status === "blocked") return decision === "answered" ? "resume" : null;
  if (task.status === "in_review") return reworkRequested(comments) ? "rework" : null;
  if (task.status !== "todo" || decision === "waiting") return null;
  if (task.labels?.includes("hold")) return null;
  const blockers = task.relations?.blockedBy ?? [];
  return blockers.every((blocker) => blockerSatisfied(blocker, commentsByTaskId)) ? "new" : null;
}

// Tasks whose comments decide eligibility; the caller fetches comments for these only.
export function needsComments(task) {
  return !task.archivedAt && ["todo", "blocked", "in_review"].includes(task.status);
}

export function rankCandidates(tasks, commentsByTaskId) {
  return tasks
    .flatMap((task) => {
      const kind = candidateKind(task, commentsByTaskId.get(task.id) ?? [], commentsByTaskId);
      return kind ? [{ task, kind }] : [];
    })
    .sort((left, right) => (
      KIND_RANK[left.kind] - KIND_RANK[right.kind]
      || (PRIORITY_RANK[left.task.priority] ?? 4) - (PRIORITY_RANK[right.task.priority] ?? 4)
      || left.task.sortOrder - right.task.sortOrder
    ));
}

// Loop runner heartbeats per project, written by `taskctl loop heartbeat` and `taskctl next --claim`:
// { [projectId]: { tickStartedAt, tickEndedAt, activityAt, note } }.
export const LOOP_RUNNER_STORAGE_KEY = "taskboard.loopRunner.v1";
const STUCK_AFTER_MS = 15 * 60_000;
const NOT_RUNNING_AFTER_MS = 90 * 60_000;

// The header status of a project's loop runner, or null when there is nothing to show.
// An open tick is "stuck" once 15 minutes pass without tick activity or a task heartbeat.
export function loopRunnerStatus(runner, enabled, tasks, now) {
  const at = (value) => (typeof value === "string" ? Date.parse(value) || 0 : 0);
  const started = at(runner?.tickStartedAt);
  const ended = at(runner?.tickEndedAt);
  const activity = at(runner?.activityAt);
  if (started && started > ended) {
    const heartbeat = Math.max(0, ...tasks.map((task) => at(task.agentSession?.heartbeatAt)));
    const stuck = now - Math.max(started, activity, heartbeat) > STUCK_AFTER_MS;
    return { state: stuck ? "stuck" : "in_progress", since: started };
  }
  const lastTick = Math.max(ended, activity);
  if (lastTick && now - lastTick < NOT_RUNNING_AFTER_MS) return { state: "running", since: lastTick };
  return enabled ? { state: "not_running", since: lastTick || null } : null;
}
