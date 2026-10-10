export const AGENT_LOOP_STORAGE_KEY: string;
export const MAX_CONCURRENT_LIMIT: number;
export type ProjectLoopSettings = { enabled: boolean; maxConcurrent: number };
export function parseAgentLoopSettings(raw: string | null | undefined): Record<string, ProjectLoopSettings>;
export function projectLoopSettings(
  settings: Record<string, unknown> | null | undefined,
  projectId: string,
): ProjectLoopSettings;
export function isAgentWorking(task: {
  status: string;
  agentSession?: unknown;
  threadBinding?: unknown;
  threadId?: unknown;
}): boolean;
