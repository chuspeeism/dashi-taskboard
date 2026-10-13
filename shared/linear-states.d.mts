export const LINEAR_STATE_STATUSES: ReadonlyArray<readonly [string, string]>;
export function linearStatesForStatus(status: string): string[];
export function linearQaState(task: {
  source?: string;
  status: string;
  externalState?: string | null;
}): "waiting" | "failed" | null;
