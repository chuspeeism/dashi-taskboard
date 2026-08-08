import type {
  Task,
  TaskIntervention,
  TaskInterventionManualMode,
  TaskInterventionView,
} from "./types";

export const TASK_INTERVENTION_VIEWS: TaskInterventionView[] = ["resolve", "follow_up", "comment"];

export const TASK_INTERVENTION_VIEW_DETAILS: Record<
  TaskInterventionView,
  { label: string; description: string }
> = {
  resolve: {
    label: "待我解决",
    description: "需要你补充信息、确认方案或处理异常",
  },
  follow_up: {
    label: "待我跟进",
    description: "需要你验收、查看异常或处理停滞",
  },
  comment: {
    label: "待我评论",
    description: "明确等待你的回复",
  },
};

export const EMPTY_TASK_INTERVENTION: TaskIntervention = {
  views: [],
  reasons: [],
  primary: null,
  progress: null,
  lastActivityAt: null,
  manual: {},
};

export function taskIntervention(task: Pick<Task, "intervention">): TaskIntervention {
  return task.intervention ?? EMPTY_TASK_INTERVENTION;
}

export function readTaskInterventionView(search = window.location.search): TaskInterventionView | null {
  const value = new URLSearchParams(search).get("attention");
  return TASK_INTERVENTION_VIEWS.includes(value as TaskInterventionView)
    ? value as TaskInterventionView
    : null;
}

export function writeTaskInterventionView(view: TaskInterventionView | null): void {
  const url = new URL(window.location.href);
  if (view) url.searchParams.set("attention", view);
  else url.searchParams.delete("attention");
  window.history.replaceState(window.history.state, "", url);
}

export function interventionManualLabel(
  mode: TaskInterventionManualMode | "auto" | undefined,
): string {
  if (mode === "include") return "强制加入";
  if (mode === "exclude") return "暂时移出";
  return "自动判断";
}
