export function missingSprintLabels(tasks: ReadonlyArray<{
  id: string;
  labels: ReadonlyArray<string>;
  estimate?: number | null;
  inScope?: boolean | null;
}>, cycleName: string | null | undefined): {
  sprintNumber: number;
  suggestedLabel: string;
  taskIds: Set<string>;
  points: number;
} | null;
