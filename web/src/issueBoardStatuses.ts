import type { TaskStatus } from "./types";

export const MAIN_STATUSES = [
  "todo",
  "in_progress",
  "blocked",
  "in_review",
] as const satisfies readonly TaskStatus[];

export const SECONDARY_STATUSES = [
  "backlog",
  "done",
  "canceled",
] as const satisfies readonly TaskStatus[];

export type OtherTaskTab = TaskStatus | "archived";
