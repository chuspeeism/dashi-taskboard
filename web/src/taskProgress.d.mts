export type TaskProgressPhase = "analyzing" | "implementing" | "verifying" | "finishing" | "complete";
export type TaskProgressDisplayPhase = TaskProgressPhase | "paused";

export interface TaskProgressInput {
  completed: number | null;
  total: number | null;
  running: boolean;
}

export interface TaskProgressPresentation {
  percent: number;
  completed: number;
  total: number;
  remaining: number;
  phase: TaskProgressPhase;
  running: boolean;
}

export function presentTaskProgress(processing: TaskProgressInput | null | undefined): TaskProgressPresentation | null;
export function displayTaskProgressPhase(progress: TaskProgressPresentation | null | undefined): TaskProgressDisplayPhase | null;
export function taskProgressRemainingLabel(remaining: number, language: "zh" | "en"): string;
export function presentTaskElapsed(startedAt: string | null | undefined, now: number): string;
