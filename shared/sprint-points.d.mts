export function sprintPoints(tasks: ReadonlyArray<{
  status: string;
  estimate?: number | null;
  inScope?: boolean | null;
}>): {
  total: number;
  completed: number;
  remaining: number;
  byStatus: Record<string, number>;
};
