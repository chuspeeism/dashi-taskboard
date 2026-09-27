import { taskboardStorage } from "./storage";
import {
  TASK_PRIORITIES,
  type DevelopmentContext,
  type DevelopmentScan,
  type TaskPriority,
} from "./types";

export interface TaskEditorDefaults {
  priority: TaskPriority;
  labels: string[];
}

function storageKey(projectId: string, userKey: string): string {
  return `taskboard.new-task-defaults.v1.${JSON.stringify([projectId, userKey])}`;
}

export function readTaskEditorDefaults(
  projectId: string | null,
  userKey: string,
  availableLabels: readonly string[],
): TaskEditorDefaults {
  if (!projectId) return { priority: "none", labels: [] };
  try {
    const raw = taskboardStorage.getItem(storageKey(projectId, userKey));
    if (!raw) return { priority: "none", labels: [] };
    const value = JSON.parse(raw) as { priority?: unknown; labels?: unknown };
    const priority = typeof value.priority === "string" && TASK_PRIORITIES.includes(value.priority as TaskPriority)
      ? value.priority as TaskPriority
      : "none";
    const available = new Set(availableLabels);
    const labels = Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string" && available.has(label))
      : [];
    return { priority, labels };
  } catch {
    return { priority: "none", labels: [] };
  }
}

export function saveTaskEditorDefaults(
  projectId: string | null,
  userKey: string,
  priority: TaskPriority,
  labels: readonly string[],
): void {
  if (!projectId) return;
  try {
    taskboardStorage.setItem(storageKey(projectId, userKey), JSON.stringify({ priority, labels }));
  } catch {
    // Preferences are optional and must not block task creation.
  }
}

function samePath(left: string, right: string): boolean {
  return left.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()
    === right.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

export function currentDevelopmentContext(scan: DevelopmentScan): DevelopmentContext | null {
  if (!scan.workspacePath) return null;
  const matches = scan.contexts.filter((context) => (
    context.type === "worktree"
    && context.branch !== null
    && samePath(context.path, scan.workspacePath!)
  ));
  return matches.length === 1 && matches[0].type === "worktree" && matches[0].branch
    ? { type: "branch", branch: matches[0].branch }
    : null;
}
